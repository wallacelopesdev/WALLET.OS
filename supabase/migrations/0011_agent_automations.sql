-- WALLET OS — Financial Agent: automações, recorrências e alertas.
--
-- Migration não destrutiva. Nada aqui movimenta dinheiro nem altera lançamentos: as
-- automações só leem dados e criam avisos. Cada aviso tem uma chave e nunca se repete.

alter table public.notifications
  add column severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  add column dedupe_key text,
  add column action_url text;

create unique index notifications_user_dedupe_idx
  on public.notifications (user_id, dedupe_key) where dedupe_key is not null;

-- O cliente só marca como lido.
revoke insert, update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

create table public.recurring_charges (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  normalized_key text not null,
  description    text not null,
  amount_cents   bigint not null,
  period         text not null check (period in ('monthly', 'weekly')),
  occurrences    integer not null,
  last_date      date not null,
  next_date      date not null,
  dismissed      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, normalized_key)
);

create trigger set_updated_at before update on public.recurring_charges
  for each row execute function public.set_updated_at();

alter table public.recurring_charges enable row level security;
create policy recurring_charges_owner on public.recurring_charges for select to authenticated
  using (user_id = auth.uid());
create policy recurring_charges_dismiss on public.recurring_charges for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.recurring_charges from anon, authenticated;
grant select on public.recurring_charges to authenticated;
grant update (dismissed) on public.recurring_charges to authenticated;

-- ---------------------------------------------------------------------------
-- Cria o aviso uma única vez. Devolve 1 quando criou.
-- ---------------------------------------------------------------------------
create function public._agent_notify(
  p_user uuid, p_key text, p_title text, p_body text, p_kind text,
  p_severity text default 'info', p_url text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.notifications (user_id, title, body, kind, severity, dedupe_key, action_url)
  values (p_user, p_title, p_body, p_kind, p_severity, p_key, p_url)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public._agent_money(p_cents bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'R$ ' || replace(replace(replace(to_char(p_cents / 100.0, 'FM999G999G999G990D00'), ',', '#'), '.', ','), '#', '.');
$$;

-- ---------------------------------------------------------------------------
-- Cobranças recorrentes: 3 ou mais, em intervalo regular e valor parecido.
-- ---------------------------------------------------------------------------
create function public._agent_detect_recurring(p_user uuid, p_today date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_created integer := 0;
  v_next date;
begin
  for v_row in
    with base as (
      select public.agent_normalize(regexp_replace(t.description, '\(\d+/\d+\)', '')) as key,
             t.description, t.posted_at, -t.amount_cents as amount
        from public.transactions t
       where t.user_id = p_user and t.kind::text = 'expense'
         and t.installment_id is null
         and t.description !~ '\(\d+/\d+\)'
         and t.posted_at between p_today - 400 and p_today
    ),
    gaps as (
      select key, description, posted_at, amount,
             posted_at - lag(posted_at) over (partition by key order by posted_at) as gap
        from base
       where key <> ''
    )
    select key,
           (array_agg(description order by posted_at desc))[1] as description,
           (array_agg(amount order by posted_at desc))[1] as last_amount,
           max(posted_at) as last_date,
           count(*)::integer as occurrences,
           min(amount) as min_amount,
           max(amount) as max_amount,
           min(gap) as min_gap,
           max(gap) as max_gap
      from gaps
     group by key
    having count(*) >= 3
  loop
    -- Valor varia até 20% entre as cobranças.
    continue when v_row.max_amount > v_row.min_amount * 1.2;

    if v_row.min_gap >= 25 and v_row.max_gap <= 35 then
      v_next := (v_row.last_date + interval '1 month')::date;
      insert into public.recurring_charges
        (user_id, normalized_key, description, amount_cents, period, occurrences, last_date, next_date)
      values (p_user, v_row.key, v_row.description, v_row.last_amount, 'monthly', v_row.occurrences, v_row.last_date, v_next)
      on conflict (user_id, normalized_key) do update
        set description = excluded.description, amount_cents = excluded.amount_cents, period = excluded.period,
            occurrences = excluded.occurrences, last_date = excluded.last_date, next_date = excluded.next_date;
    elsif v_row.min_gap >= 6 and v_row.max_gap <= 8 then
      v_next := v_row.last_date + 7;
      insert into public.recurring_charges
        (user_id, normalized_key, description, amount_cents, period, occurrences, last_date, next_date)
      values (p_user, v_row.key, v_row.description, v_row.last_amount, 'weekly', v_row.occurrences, v_row.last_date, v_next)
      on conflict (user_id, normalized_key) do update
        set description = excluded.description, amount_cents = excluded.amount_cents, period = excluded.period,
            occurrences = excluded.occurrences, last_date = excluded.last_date, next_date = excluded.next_date;
    else
      continue;
    end if;

    if public._agent_notify(
      p_user, 'recurring:' || v_row.key,
      'Cobrança recorrente identificada',
      v_row.description || ': ' || public._agent_money(v_row.last_amount) || '. Próxima prevista para '
        || to_char(v_next, 'DD/MM/YYYY') || '.',
      'recurring', 'info', '/agente'
    ) = 1 then
      v_created := v_created + 1;
      perform public._agent_log(p_user, 'agent.recurring_identified', 'recurring_charge', v_row.key,
        jsonb_build_object('description', v_row.description, 'amount_cents', v_row.last_amount));
    end if;
  end loop;

  return v_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- Despesa incomum: 3x a média do mesmo estabelecimento ou categoria, com pelo menos 5
-- exemplos e acima de R$ 100, para não alarmar à toa.
-- ---------------------------------------------------------------------------
create function public._agent_detect_anomalies(p_user uuid, p_today date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_created integer := 0;
begin
  for v_row in
    select t.id, t.description, -t.amount_cents as amount, s.average
      from public.transactions t
      cross join lateral (
        select avg(-h.amount_cents) as average, count(*) as samples
          from public.transactions h
         where h.user_id = p_user and h.id <> t.id and h.kind::text = 'expense'
           and h.posted_at between t.posted_at - 180 and t.posted_at - 1
           and h.installment_id is null
           and (
             (t.category_id is not null and h.category_id = t.category_id)
             or (t.category_id is null and public.agent_normalize(h.description) = public.agent_normalize(t.description))
           )
      ) s
     where t.user_id = p_user and t.kind::text = 'expense'
       and t.installment_id is null
       and t.posted_at between p_today - 3 and p_today
       and -t.amount_cents > 10000
       and s.samples >= 5
       and -t.amount_cents > s.average * 3
  loop
    v_created := v_created + public._agent_notify(
      p_user, 'anomaly:' || v_row.id::text,
      'Despesa acima do seu padrão',
      v_row.description || ': ' || public._agent_money(v_row.amount) || ', a média costuma ser '
        || public._agent_money(round(v_row.average)::bigint) || '.',
      'anomaly', 'warning', '/transacoes'
    );
  end loop;
  return v_created;
end;
$$;

-- Possível cobrança duplicada: mesmo estabelecimento e valor, em até um dia. Só avisa.
create function public._agent_detect_duplicates(p_user uuid, p_today date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_created integer := 0;
begin
  for v_row in
    select a.id as first_id, b.id as second_id, b.description, -b.amount_cents as amount
      from public.transactions a
      join public.transactions b
        on b.user_id = a.user_id and b.id > a.id
       and b.amount_cents = a.amount_cents
       and abs(b.posted_at - a.posted_at) <= 1
       and b.card_id is not distinct from a.card_id
       and b.account_id is not distinct from a.account_id
     where a.user_id = p_user and a.kind::text = 'expense' and b.kind::text = 'expense'
       and a.installment_id is null and b.installment_id is null
       and b.posted_at between p_today - 7 and p_today
       and public.agent_normalize(a.description) = public.agent_normalize(b.description)
       and public.agent_normalize(a.description) <> ''
  loop
    v_created := v_created + public._agent_notify(
      p_user, 'duplicate:' || v_row.first_id::text || ':' || v_row.second_id::text,
      'Possível cobrança duplicada',
      v_row.description || ' aparece duas vezes com ' || public._agent_money(v_row.amount) || '. Confira com o seu banco.',
      'duplicate', 'warning', '/transacoes'
    );
  end loop;
  return v_created;
end;
$$;

-- Vencimentos de faturas e boletos, e saúde das conexões.
create function public._agent_detect_deadlines(p_user uuid, p_today date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_created integer := 0;
begin
  for v_row in
    select i.id, c.name, i.due_date, i.total_cents - i.paid_cents as remaining, c.id as card_id
      from public.card_invoices i
      join public.credit_cards c on c.id = i.card_id
     where i.user_id = p_user and i.total_cents > i.paid_cents
       and i.closing_date <= p_today and i.due_date <= p_today + 5
  loop
    if v_row.due_date < p_today then
      v_created := v_created + public._agent_notify(
        p_user, 'invoice_overdue:' || v_row.id::text, 'Fatura atrasada',
        v_row.name || ': ' || public._agent_money(v_row.remaining) || ', venceu em ' || to_char(v_row.due_date, 'DD/MM/YYYY') || '.',
        'invoice', 'critical', '/cartoes/' || v_row.card_id::text || '/faturas/' || v_row.id::text
      );
    else
      v_created := v_created + public._agent_notify(
        p_user, 'invoice_due:' || v_row.id::text, 'Fatura perto do vencimento',
        v_row.name || ': ' || public._agent_money(v_row.remaining) || ', vence em ' || to_char(v_row.due_date, 'DD/MM/YYYY') || '.',
        'invoice', 'warning', '/cartoes/' || v_row.card_id::text || '/faturas/' || v_row.id::text
      );
    end if;
  end loop;

  for v_row in
    select b.id, b.beneficiary, b.amount_cents, b.due_date
      from public.bills b
     where b.user_id = p_user and b.paid_transaction_id is null and not b.dismissed
       and b.due_date <= p_today + 5
  loop
    v_created := v_created + public._agent_notify(
      p_user,
      (case when v_row.due_date < p_today then 'bill_overdue:' else 'bill_due:' end) || v_row.id::text,
      case when v_row.due_date < p_today then 'Boleto vencido' else 'Boleto perto do vencimento' end,
      v_row.beneficiary || ': ' || public._agent_money(v_row.amount_cents) || ', vencimento em ' || to_char(v_row.due_date, 'DD/MM/YYYY') || '.',
      'bill', case when v_row.due_date < p_today then 'critical' else 'warning' end, '/agente/boletos'
    );
  end loop;

  for v_row in
    select c.id, coalesce(c.institution_name, 'Banco') as name, c.status, c.consent_expires_at, c.last_error_code
      from public.provider_connections c
     where c.user_id = p_user and c.status <> 'disconnected'
  loop
    if v_row.status in ('error', 'expired') then
      v_created := v_created + public._agent_notify(
        p_user, 'connection:' || v_row.id::text || ':' || v_row.status || ':' || p_today::text,
        case when v_row.status = 'expired' then 'Autorização do banco vencida' else 'Falha ao sincronizar' end,
        v_row.name || ': ' || case when v_row.status = 'expired'
          then 'renove a autorização no painel da Pluggy para voltar a receber lançamentos.'
          else 'tentarei de novo automaticamente.' end,
        'connection', 'critical', '/agente/conexoes'
      );
    elsif v_row.consent_expires_at is not null and v_row.consent_expires_at::date <= p_today + 30 then
      v_created := v_created + public._agent_notify(
        p_user, 'consent:' || v_row.id::text || ':' || to_char(v_row.consent_expires_at, 'YYYY-MM-DD'),
        'Autorização do banco vencendo',
        v_row.name || ': a autorização vence em ' || to_char(v_row.consent_expires_at, 'DD/MM/YYYY') || '. Renove no painel da Pluggy.',
        'connection', 'warning', '/agente/conexoes'
      );
    end if;
  end loop;

  return v_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- Resumos do dia, da semana e do mês anteriores. Transferências e pagamentos de fatura
-- não contam, e estornos reduzem as despesas.
-- ---------------------------------------------------------------------------
create function public._agent_digest(
  p_user uuid, p_key text, p_title text, p_from date, p_to date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_income bigint;
  v_expense bigint;
  v_count integer;
begin
  select coalesce(sum(t.amount_cents) filter (where t.kind::text not in ('refund', 'transfer', 'invoice_payment') and t.amount_cents > 0), 0)::bigint,
         coalesce(-sum(t.amount_cents) filter (where t.kind::text = 'expense' or t.kind::text = 'refund' or (t.kind::text not in ('transfer', 'invoice_payment', 'income') and t.amount_cents < 0)), 0)::bigint,
         count(*)::integer
    into v_income, v_expense, v_count
    from public.transactions t
   where t.user_id = p_user and t.posted_at between p_from and p_to
     and t.kind::text not in ('transfer', 'invoice_payment');

  if v_count = 0 then
    return 0;
  end if;

  return public._agent_notify(
    p_user, p_key, p_title,
    'Receitas: ' || public._agent_money(v_income) || '. Despesas: ' || public._agent_money(v_expense)
      || '. ' || v_count::text || case when v_count = 1 then ' lançamento.' else ' lançamentos.' end,
    'digest', 'info', '/transacoes?de=' || p_from::text || '&ate=' || p_to::text
  );
end;
$$;

create function public._agent_enabled(p_settings public.agent_settings, p_name text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(((p_settings).automations ->> p_name)::boolean, true);
$$;

-- ---------------------------------------------------------------------------
-- Automações diárias. p_today vem do servidor, no fuso de Brasília.
-- ---------------------------------------------------------------------------
create function public.agent_run_automations(p_token text, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._capture_user(p_token);
  v_settings public.agent_settings;
  v_run uuid;
  v_recurring integer := 0;
  v_anomalies integer := 0;
  v_duplicates integer := 0;
  v_deadlines integer := 0;
  v_digests integer := 0;
  v_summary jsonb;
begin
  select * into v_settings from public.agent_settings s where s.user_id = v_user;
  if v_settings.paused then
    return jsonb_build_object('paused', true);
  end if;

  update public.agent_runs
     set status = 'failed', finished_at = now(), error_code = 'interrupted'
   where user_id = v_user and kind = 'automations' and status = 'running'
     and started_at < now() - interval '15 minutes';

  insert into public.agent_runs (user_id, kind) values (v_user, 'automations')
  on conflict (user_id, kind) where status = 'running' do nothing
  returning id into v_run;
  if v_run is null then
    return jsonb_build_object('skipped', 'already_running');
  end if;

  if public._agent_enabled(v_settings, 'recurring') then
    v_recurring := public._agent_detect_recurring(v_user, p_today);
  end if;
  if public._agent_enabled(v_settings, 'anomalies') then
    v_anomalies := public._agent_detect_anomalies(v_user, p_today);
  end if;
  if public._agent_enabled(v_settings, 'duplicates') then
    v_duplicates := public._agent_detect_duplicates(v_user, p_today);
  end if;
  if public._agent_enabled(v_settings, 'deadlines') then
    v_deadlines := public._agent_detect_deadlines(v_user, p_today);
  end if;
  if public._agent_enabled(v_settings, 'digests') then
    v_digests := public._agent_digest(v_user, 'digest:day:' || (p_today - 1)::text, 'Resumo de ontem', p_today - 1, p_today - 1);
    if extract(isodow from p_today) = 1 then
      v_digests := v_digests + public._agent_digest(v_user, 'digest:week:' || p_today::text, 'Resumo da semana', p_today - 7, p_today - 1);
    end if;
    if extract(day from p_today) = 1 then
      v_digests := v_digests + public._agent_digest(
        v_user, 'digest:month:' || p_today::text, 'Resumo do mês',
        (p_today - interval '1 month')::date, p_today - 1
      );
    end if;
  end if;

  v_summary := jsonb_build_object(
    'recurring', v_recurring, 'anomalies', v_anomalies, 'duplicates', v_duplicates,
    'deadlines', v_deadlines, 'digests', v_digests
  );

  update public.agent_runs
     set status = 'success', finished_at = now(), summary = v_summary
   where id = v_run;

  return v_summary;
end;
$$;

create function public.agent_is_paused(p_token text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.paused from public.agent_settings s where s.user_id = public._capture_user(p_token)),
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
revoke all on function public._agent_notify(uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public._agent_detect_recurring(uuid, date) from public, anon, authenticated;
revoke all on function public._agent_detect_anomalies(uuid, date) from public, anon, authenticated;
revoke all on function public._agent_detect_duplicates(uuid, date) from public, anon, authenticated;
revoke all on function public._agent_detect_deadlines(uuid, date) from public, anon, authenticated;
revoke all on function public._agent_digest(uuid, text, text, date, date) from public, anon, authenticated;

revoke all on function public.agent_run_automations(text, date) from public;
revoke all on function public.agent_is_paused(text) from public;
grant execute on function public.agent_run_automations(text, date) to anon, authenticated;
grant execute on function public.agent_is_paused(text) to anon, authenticated;

notify pgrst, 'reload schema';
