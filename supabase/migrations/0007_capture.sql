-- WALLET OS — Captura automática: Atalhos do iPhone e Open Finance (Meu Pluggy).
--
-- Migration não destrutiva: só cria tabelas e funções novas. Pode ser executada inteira
-- de uma vez no SQL Editor. O texto bruto das mensagens nunca é guardado.
--
-- capture_events registra cada evento recebido. É o que torna a captura idempotente e
-- evita duplicar a mesma compra vinda de duas fontes (Apple Pay na hora + banco no dia
-- seguinte) ou já digitada à mão. O que o sistema não consegue decidir sozinho fica
-- "pending" para revisão e não entra nos saldos.

create table public.capture_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 60),
  -- SHA-256 do token. O token em si é mostrado uma única vez e não fica no banco.
  token_hash   text not null unique,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index capture_tokens_user_idx on public.capture_tokens (user_id, created_at desc);

create table public.capture_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  source         text not null check (source in ('apple_pay', 'notification', 'sms', 'email', 'pluggy')),
  external_ref   text,
  description    text not null,
  amount_cents   bigint not null check (amount_cents <> 0),
  event_date     date not null,
  payment_method public.payment_method,
  location       text,
  transaction_id uuid references public.transactions (id) on delete set null,
  status         text not null check (status in ('created', 'matched', 'pending', 'resolved', 'discarded')),
  reason         text,
  created_at     timestamptz not null default now()
);
create unique index capture_events_external_uidx
  on public.capture_events (user_id, external_ref) where external_ref is not null;
create index capture_events_pending_idx
  on public.capture_events (user_id, created_at desc) where status = 'pending';
create index capture_events_transaction_idx
  on public.capture_events (transaction_id) where transaction_id is not null;

-- Liga uma conta da Pluggy a uma conta ou cartão do WALLET OS. Só entra o que acontecer
-- a partir de linked_at: o histórico anterior já está nos saldos informados à mão.
create table public.pluggy_links (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  pluggy_account_id text not null,
  pluggy_type       text not null check (pluggy_type in ('BANK', 'CREDIT')),
  label             text not null,
  account_id        uuid,
  card_id           uuid,
  linked_at         timestamptz not null default now(),
  last_synced_at    timestamptz,
  unique (user_id, pluggy_account_id),
  check ((account_id is null) <> (card_id is null)),
  foreign key (account_id, user_id) references public.bank_accounts (id, user_id) on delete cascade,
  foreign key (card_id, user_id) references public.credit_cards (id, user_id) on delete cascade
);

alter table public.capture_tokens enable row level security;
alter table public.capture_events enable row level security;
alter table public.pluggy_links enable row level security;

create policy capture_tokens_owner on public.capture_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy capture_events_owner on public.capture_events for select to authenticated
  using (user_id = auth.uid());
create policy pluggy_links_owner on public.pluggy_links for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.capture_tokens, public.capture_events, public.pluggy_links from anon;

-- O hash do token não é legível pelo cliente; o único campo alterável é a revogação.
revoke all on public.capture_tokens from authenticated;
grant select (id, user_id, name, last_used_at, revoked_at, created_at) on public.capture_tokens to authenticated;
grant insert (user_id, name, token_hash) on public.capture_tokens to authenticated;
grant update (revoked_at) on public.capture_tokens to authenticated;

-- Eventos só mudam pelas funções abaixo.
revoke all on public.capture_events from authenticated;
grant select on public.capture_events to authenticated;

revoke update on public.pluggy_links from authenticated;

-- ---------------------------------------------------------------------------
-- Quem está chamando: token do iPhone/agendador ou sessão do usuário.
-- ---------------------------------------------------------------------------
create function public._capture_user(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if p_token is null then
    v_user := auth.uid();
  else
    update public.capture_tokens t
       set last_used_at = now()
     where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
       and t.revoked_at is null
    returning t.user_id into v_user;
  end if;

  if v_user is null then
    raise exception 'invalid credentials' using errcode = '42501';
  end if;
  return v_user;
end;
$$;

-- Grava o lançamento. Repete a categoria usada da última vez com a mesma descrição.
create function public._capture_post(
  p_user uuid, p_description text, p_amount_cents bigint, p_date date,
  p_method public.payment_method, p_account uuid, p_card uuid, p_location text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category uuid;
  v_notes text := 'Captura automática' || coalesce(' · ' || p_location, '');
  v_dedupe text := 'capture:' || gen_random_uuid()::text;
  v_id uuid;
begin
  select t.category_id into v_category
    from public.transactions t
    join public.transaction_categories c on c.id = t.category_id
   where t.user_id = p_user
     and lower(t.description) = lower(p_description)
     and not c.archived
     and c.kind::text = case when p_amount_cents > 0 then 'income' else 'expense' end
   order by t.posted_at desc
   limit 1;

  if p_card is not null then
    return public._insert_card_purchase(
      p_user, p_card, p_description, -p_amount_cents, 1, p_date, v_category, v_notes, v_dedupe
    );
  end if;

  insert into public.transactions
    (user_id, account_id, category_id, category_source, posted_at, description,
     amount_cents, kind, payment_method, notes, dedupe_hash)
  values
    (p_user, p_account, v_category,
     case when v_category is not null then 'rule'::public.category_source end,
     p_date, p_description, p_amount_cents,
     (case when p_amount_cents > 0 then 'income' else 'expense' end)::public.tx_kind,
     p_method, v_notes, v_dedupe)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Entrada de um evento. p_amount_cents: negativo é saída, positivo é entrada.
-- ---------------------------------------------------------------------------
create function public.ingest_capture(
  p_token        text,
  p_source       text,
  p_external_ref text,
  p_description  text,
  p_amount_cents bigint,
  p_date         date,
  p_method       text,
  p_hint         text,
  p_last4        text,
  p_account      uuid,
  p_card         uuid,
  p_location     text,
  p_reason       text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._capture_user(p_token);
  v_method public.payment_method;
  v_description text := left(btrim(coalesce(p_description, '')), 200);
  v_location text := nullif(left(btrim(coalesce(p_location, '')), 200), '');
  v_hint text := nullif(lower(btrim(coalesce(p_hint, ''))), '');
  v_account uuid;
  v_card uuid;
  v_ids uuid[];
  v_reason text := p_reason;
  v_tx uuid;
  v_status text;
begin
  if p_source not in ('apple_pay', 'notification', 'sms', 'email', 'pluggy') then
    raise exception 'invalid source' using errcode = 'WL013';
  end if;
  if p_amount_cents is null or p_amount_cents = 0 or abs(p_amount_cents) > 100000000000000 then
    raise exception 'invalid amount' using errcode = 'WL004';
  end if;
  if v_description = '' then
    v_description := case when p_amount_cents > 0 then 'Entrada capturada' else 'Saída capturada' end;
  end if;
  if p_method in ('pix', 'cash', 'debit', 'credit', 'boleto', 'transfer', 'other') then
    v_method := p_method::public.payment_method;
  end if;

  -- Mesmo evento reenviado.
  if p_external_ref is not null and exists (
    select 1 from public.capture_events e
     where e.user_id = v_user and e.external_ref = p_external_ref
  ) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  -- Atalho executado duas vezes para o mesmo evento: sem identificador, usa a janela curta.
  if p_external_ref is null and exists (
    select 1 from public.capture_events e
     where e.user_id = v_user and e.source = p_source
       and e.amount_cents = p_amount_cents
       and lower(e.description) = lower(v_description)
       and e.created_at > now() - interval '2 minutes'
  ) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  -- Destino: explícito (Pluggy) ou deduzido da dica (nome ou últimos dígitos).
  if p_account is not null then
    select a.id into v_account from public.bank_accounts a
     where a.id = p_account and a.user_id = v_user and not a.archived;
  elsif p_card is not null then
    select c.id into v_card from public.credit_cards c
     where c.id = p_card and c.user_id = v_user and not c.archived;
  else
    -- Entrada nunca vai para cartão; débito e Pix nunca vão; crédito só vai para cartão.
    if p_amount_cents < 0 and (v_method is null or v_method = 'credit') then
      select array_agg(c.id) into v_ids from public.credit_cards c
       where c.user_id = v_user and not c.archived
         and (
           (nullif(p_last4, '') is not null and c.last4 = p_last4)
           or (nullif(p_last4, '') is null and v_hint is not null and (
                 position(lower(c.name) in v_hint) > 0
                 or position(v_hint in lower(c.name)) > 0
                 or position(lower(c.institution) in v_hint) > 0))
         );
      if cardinality(v_ids) = 1 then
        v_card := v_ids[1];
      end if;
    end if;

    if v_card is null and v_hint is not null
       and (p_amount_cents > 0 or v_method is distinct from 'credit') then
      select array_agg(a.id) into v_ids from public.bank_accounts a
       where a.user_id = v_user and not a.archived
         and (position(lower(a.name) in v_hint) > 0
              or position(v_hint in lower(a.name)) > 0
              or position(lower(coalesce(a.institution, chr(1))) in v_hint) > 0);
      if cardinality(v_ids) = 1 then
        v_account := v_ids[1];
      end if;
    end if;
  end if;

  if v_reason is null and v_account is null and v_card is null then
    v_reason := 'Não identifiquei a conta ou o cartão';
  end if;
  if v_reason is null and v_card is not null and p_amount_cents > 0 then
    v_reason := 'Estorno ou crédito no cartão';
  end if;

  if v_reason is not null then
    insert into public.capture_events
      (user_id, source, external_ref, description, amount_cents, event_date, payment_method, location, status, reason)
    values
      (v_user, p_source, p_external_ref, v_description, p_amount_cents, p_date, v_method, v_location, 'pending', v_reason);
    return jsonb_build_object('status', 'pending', 'reason', v_reason);
  end if;

  -- Já existe? Lançamento igual, em até um dia, ainda não usado por esta mesma fonte.
  select t.id into v_tx
    from public.transactions t
   where t.user_id = v_user
     and t.amount_cents = p_amount_cents
     and t.kind::text in ('income', 'expense')
     and t.posted_at between p_date - 1 and p_date + 1
     and ((v_card is not null and t.card_id = v_card and t.account_id is null)
          or (v_account is not null and t.account_id = v_account))
     and not exists (
       select 1 from public.capture_events e
        where e.transaction_id = t.id and e.source = p_source
     )
   order by abs(t.posted_at - p_date), t.created_at
   limit 1;

  if v_tx is not null then
    v_status := 'matched';
  else
    v_tx := public._capture_post(
      v_user, v_description, p_amount_cents, p_date, v_method, v_account, v_card, v_location
    );
    v_status := 'created';
  end if;

  insert into public.capture_events
    (user_id, source, external_ref, description, amount_cents, event_date, payment_method, location, transaction_id, status)
  values
    (v_user, p_source, p_external_ref, v_description, p_amount_cents, p_date, v_method, v_location, v_tx, v_status);

  set constraints all immediate;
  return jsonb_build_object('status', v_status, 'transaction_id', v_tx);
end;
$$;

-- ---------------------------------------------------------------------------
-- Revisão do que ficou pendente (somente pela sessão do usuário).
-- ---------------------------------------------------------------------------
create function public.resolve_capture(p_event uuid, p_account uuid, p_card uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_event public.capture_events;
  v_tx uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select * into v_event from public.capture_events e
   where e.id = p_event and e.user_id = v_user and e.status = 'pending'
     for update;
  if not found then
    raise exception 'event not found' using errcode = 'P0002';
  end if;

  if (p_account is null) = (p_card is null) then
    raise exception 'choose one target' using errcode = 'WL013';
  end if;
  if p_card is not null and v_event.amount_cents > 0 then
    raise exception 'entry cannot go to a card' using errcode = 'WL013';
  end if;
  if p_account is not null and not exists (
    select 1 from public.bank_accounts a
     where a.id = p_account and a.user_id = v_user and not a.archived
  ) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  v_tx := public._capture_post(
    v_user, v_event.description, v_event.amount_cents, v_event.event_date,
    v_event.payment_method, p_account, p_card, v_event.location
  );

  update public.capture_events
     set status = 'resolved', transaction_id = v_tx
   where id = p_event;

  set constraints all immediate;
  return v_tx;
end;
$$;

create function public.discard_capture(p_event uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  update public.capture_events
     set status = 'discarded'
   where id = p_event and user_id = auth.uid() and status = 'pending';

  if not found then
    raise exception 'event not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sincronização com a Pluggy. Volta 3 dias a cada execução porque o banco pode lançar
-- com atraso; os eventos já vistos são reconhecidos pelo identificador.
-- ---------------------------------------------------------------------------
create function public.pluggy_sync_targets(p_token text)
returns table (
  pluggy_account_id text,
  pluggy_type text,
  account_id uuid,
  card_id uuid,
  date_from date
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
           )
      from public.pluggy_links l
     where l.user_id = v_user;
end;
$$;

create function public.pluggy_mark_synced(p_token text, p_pluggy_account text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._capture_user(p_token);
begin
  update public.pluggy_links
     set last_synced_at = now()
   where user_id = v_user and pluggy_account_id = p_pluggy_account;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios. As funções com token são chamadas pelo servidor com a chave pública;
-- sem um token válido ou uma sessão, elas recusam.
-- ---------------------------------------------------------------------------
revoke all on function public._capture_user(text) from public, anon, authenticated;
revoke all on function public._capture_post(uuid, text, bigint, date, public.payment_method, uuid, uuid, text) from public, anon, authenticated;

revoke all on function public.ingest_capture(text, text, text, text, bigint, date, text, text, text, uuid, uuid, text, text) from public;
revoke all on function public.pluggy_sync_targets(text) from public;
revoke all on function public.pluggy_mark_synced(text, text) from public;
grant execute on function public.ingest_capture(text, text, text, text, bigint, date, text, text, text, uuid, uuid, text, text) to anon, authenticated;
grant execute on function public.pluggy_sync_targets(text) to anon, authenticated;
grant execute on function public.pluggy_mark_synced(text, text) to anon, authenticated;

revoke all on function public.resolve_capture(uuid, uuid, uuid) from public, anon;
revoke all on function public.discard_capture(uuid) from public, anon;
grant execute on function public.resolve_capture(uuid, uuid, uuid) to authenticated;
grant execute on function public.discard_capture(uuid) to authenticated;

notify pgrst, 'reload schema';
