-- WALLET OS — Financial Agent: conexões com provedores e importação de arquivos.
--
-- Migration não destrutiva. Nenhuma credencial bancária é guardada: só o identificador da
-- conexão no provedor, que não dá acesso a nada sem as credenciais da aplicação.

create table public.provider_connections (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  provider           text not null check (provider in ('pluggy')),
  external_item_id   text not null check (char_length(external_item_id) between 1 and 100),
  institution_name   text,
  status             text not null default 'active'
                       check (status in ('active', 'error', 'expired', 'disconnected')),
  consent_expires_at timestamptz,
  last_sync_at       timestamptz,
  last_error_code    text,
  failure_count      integer not null default 0,
  next_retry_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, provider, external_item_id),
  unique (id, user_id)
);

create trigger set_updated_at before update on public.provider_connections
  for each row execute function public.set_updated_at();

alter table public.provider_connections enable row level security;
create policy provider_connections_owner on public.provider_connections for select to authenticated
  using (user_id = auth.uid());
revoke all on public.provider_connections from anon, authenticated;
grant select on public.provider_connections to authenticated;

alter table public.pluggy_links
  add column connection_id uuid,
  add constraint pluggy_links_connection_user_fkey
    foreign key (connection_id, user_id)
    references public.provider_connections (id, user_id) on delete cascade;

-- Importação de arquivos: o destino pode ser conta ou cartão, sempre do próprio usuário.
alter table public.import_batches drop constraint import_batches_account_id_fkey;
alter table public.import_batches
  add column card_id uuid,
  add constraint import_batches_account_user_fkey
    foreign key (account_id, user_id) references public.bank_accounts (id, user_id)
    on delete set null (account_id),
  add constraint import_batches_card_user_fkey
    foreign key (card_id, user_id) references public.credit_cards (id, user_id)
    on delete set null (card_id),
  add constraint import_batches_id_user_key unique (id, user_id);

alter table public.transactions drop constraint transactions_batch_id_fkey;
alter table public.transactions
  add constraint transactions_batch_user_fkey
    foreign key (batch_id, user_id) references public.import_batches (id, user_id)
    on delete set null (batch_id);

-- ---------------------------------------------------------------------------
-- Conexões: somente pela sessão do usuário.
-- ---------------------------------------------------------------------------
create function public.connect_provider(p_provider text, p_item text, p_institution text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  insert into public.provider_connections (user_id, provider, external_item_id, institution_name)
  values (v_user, p_provider, btrim(p_item), nullif(btrim(coalesce(p_institution, '')), ''))
  on conflict (user_id, provider, external_item_id) do update
    set status = 'active', failure_count = 0, next_retry_at = null, last_error_code = null,
        institution_name = coalesce(excluded.institution_name, public.provider_connections.institution_name)
  returning id into v_id;

  perform public._agent_log(v_user, 'agent.connection_added', 'provider_connection', v_id::text,
    jsonb_build_object('provider', p_provider));
  return v_id;
end;
$$;

-- Para de ler a conexão e remove os vínculos. O histórico de lançamentos fica. A autorização
-- em si é revogada no provedor ou no banco: o sistema não tem como fazer isso por você.
create function public.disconnect_provider(p_connection uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  update public.provider_connections
     set status = 'disconnected', next_retry_at = null
   where id = p_connection and user_id = v_user;
  if not found then
    raise exception 'connection not found' using errcode = 'P0002';
  end if;

  delete from public.pluggy_links where connection_id = p_connection and user_id = v_user;

  perform public._agent_log(v_user, 'agent.connection_removed', 'provider_connection', p_connection::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- Sincronização: token do agendador ou sessão.
-- ---------------------------------------------------------------------------
create function public.agent_connections(p_token text)
returns table (
  id uuid,
  provider text,
  external_item_id text,
  status text,
  next_retry_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._capture_user(p_token);
begin
  return query
    select c.id, c.provider, c.external_item_id, c.status, c.next_retry_at
      from public.provider_connections c
     where c.user_id = v_user and c.status <> 'disconnected';
end;
$$;

-- Registra o resultado. Falha repetida espera cada vez mais, até 24 horas. Vencer a
-- autorização gera aviso uma vez, em vez de repetir tentativas inúteis.
create function public.agent_report_connection(
  p_token text, p_connection uuid, p_status text, p_institution text,
  p_consent_expires_at timestamptz, p_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._capture_user(p_token);
  v_failures integer;
  v_previous text;
begin
  if p_status not in ('active', 'error', 'expired') then
    raise exception 'invalid status' using errcode = 'WL013';
  end if;

  select c.status into v_previous from public.provider_connections c
   where c.id = p_connection and c.user_id = v_user;
  if not found or v_previous = 'disconnected' then
    return;
  end if;

  update public.provider_connections c
     set status = p_status,
         institution_name = coalesce(p_institution, c.institution_name),
         consent_expires_at = coalesce(p_consent_expires_at, c.consent_expires_at),
         last_error_code = case when p_status = 'active' then null else p_error_code end,
         failure_count = case when p_status = 'active' then 0 else c.failure_count + 1 end,
         last_sync_at = case when p_status = 'active' then now() else c.last_sync_at end,
         next_retry_at = case
           when p_status = 'error' then now() + least(interval '24 hours', interval '1 hour' * power(2, c.failure_count))
           else null
         end
   where c.id = p_connection
  returning c.failure_count into v_failures;

  if p_status <> 'active' and v_previous is distinct from p_status then
    perform public._agent_log(v_user, 'agent.connection_' || p_status, 'provider_connection', p_connection::text,
      jsonb_build_object('error_code', p_error_code, 'failures', v_failures));
  end if;
end;
$$;

drop function public.pluggy_sync_targets(text);

create function public.pluggy_sync_targets(p_token text)
returns table (
  pluggy_account_id text,
  pluggy_type text,
  account_id uuid,
  card_id uuid,
  date_from date,
  connection_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._capture_user(p_token);
begin
  return query
    select l.pluggy_account_id, l.pluggy_type, l.account_id, l.card_id,
           greatest(
             (l.linked_at at time zone 'America/Sao_Paulo')::date,
             coalesce((l.last_synced_at at time zone 'America/Sao_Paulo')::date - 3, date '2000-01-01')
           ),
           l.connection_id
      from public.pluggy_links l
     where l.user_id = v_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
revoke all on function public.connect_provider(text, text, text) from public, anon;
revoke all on function public.disconnect_provider(uuid) from public, anon;
grant execute on function public.connect_provider(text, text, text) to authenticated;
grant execute on function public.disconnect_provider(uuid) to authenticated;

revoke all on function public.agent_connections(text) from public;
revoke all on function public.agent_report_connection(text, uuid, text, text, timestamptz, text) from public;
revoke all on function public.pluggy_sync_targets(text) from public;
grant execute on function public.agent_connections(text) to anon, authenticated;
grant execute on function public.agent_report_connection(text, uuid, text, text, timestamptz, text) to anon, authenticated;
grant execute on function public.pluggy_sync_targets(text) to anon, authenticated;

notify pgrst, 'reload schema';
