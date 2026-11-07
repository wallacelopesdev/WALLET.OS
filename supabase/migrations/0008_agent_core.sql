-- WALLET OS — Financial Agent, núcleo.
--
-- Migration não destrutiva. Execute inteira no SQL Editor, depois da 0007, e publique o
-- código novo em seguida: a assinatura de ingest_capture muda.
--
-- O agente nunca movimenta dinheiro: tudo aqui só organiza registros. O que ele não
-- consegue provar fica "pending" e não entra nos saldos.

-- ---------------------------------------------------------------------------
-- Preferências
-- ---------------------------------------------------------------------------
create table public.agent_settings (
  user_id         uuid primary key references public.profiles (id) on delete cascade,
  paused          boolean not null default false,
  auto_register   boolean not null default true,
  auto_categorize boolean not null default true,
  min_confidence  smallint not null default 70 check (min_confidence between 50 and 100),
  automations     jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);

create trigger set_updated_at before update on public.agent_settings
  for each row execute function public.set_updated_at();

alter table public.agent_settings enable row level security;
create policy agent_settings_owner on public.agent_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.agent_settings from anon;

-- ---------------------------------------------------------------------------
-- Execuções. O índice único é a trava: uma execução por tipo, por usuário.
-- ---------------------------------------------------------------------------
create table public.agent_runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('sync', 'automations', 'import')),
  status      text not null default 'running' check (status in ('running', 'success', 'partial', 'failed')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  summary     jsonb not null default '{}'::jsonb,
  error_code  text
);
create unique index agent_runs_one_running_idx
  on public.agent_runs (user_id, kind) where status = 'running';
create index agent_runs_user_idx on public.agent_runs (user_id, started_at desc);

alter table public.agent_runs enable row level security;
create policy agent_runs_owner on public.agent_runs for select to authenticated
  using (user_id = auth.uid());
revoke all on public.agent_runs from anon, authenticated;
grant select on public.agent_runs to authenticated;

-- ---------------------------------------------------------------------------
-- Histórico de alterações: nenhuma edição apaga o valor anterior.
-- ---------------------------------------------------------------------------
create table public.transaction_revisions (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  transaction_id uuid not null,
  operation      text not null check (operation in ('update', 'delete')),
  previous       jsonb not null,
  changed_at     timestamptz not null default now()
);
create index transaction_revisions_tx_idx on public.transaction_revisions (transaction_id, changed_at desc);

alter table public.transaction_revisions enable row level security;
create policy transaction_revisions_owner on public.transaction_revisions for select to authenticated
  using (user_id = auth.uid());
revoke all on public.transaction_revisions from anon, authenticated;
grant select on public.transaction_revisions to authenticated;

create function public.transactions_record_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Exclusão em cascata do usuário: o perfil já foi removido e não há o que preservar.
  if not exists (select 1 from public.profiles p where p.id = old.user_id) then
    return null;
  end if;

  if tg_op = 'UPDATE' and (
    new.amount_cents, new.kind, new.posted_at, new.description, new.category_id, new.account_id, new.notes
  ) is not distinct from (
    old.amount_cents, old.kind, old.posted_at, old.description, old.category_id, old.account_id, old.notes
  ) then
    return null;
  end if;

  insert into public.transaction_revisions (user_id, transaction_id, operation, previous)
  values (
    old.user_id, old.id, lower(tg_op),
    jsonb_build_object(
      'amount_cents', old.amount_cents, 'kind', old.kind, 'posted_at', old.posted_at,
      'description', old.description, 'category_id', old.category_id,
      'category_source', old.category_source, 'account_id', old.account_id, 'notes', old.notes
    )
  );
  return null;
end;
$$;

create trigger transactions_record_revision
  after update or delete on public.transactions
  for each row execute function public.transactions_record_revision();

-- ---------------------------------------------------------------------------
-- Eventos: decisão do agente, sugestão e candidato encontrado.
-- ---------------------------------------------------------------------------
alter table public.capture_events drop constraint capture_events_source_check;
alter table public.capture_events
  add constraint capture_events_source_check
    check (source in ('apple_pay', 'notification', 'sms', 'email', 'pluggy', 'ofx', 'csv')),
  add column normalized_description text,
  add column intent text check (intent in ('normal', 'invoice_payment', 'refund', 'possible_transfer')),
  add column account_id uuid,
  add column card_id uuid,
  add column suggested_category_id uuid references public.transaction_categories (id) on delete set null,
  add column confidence smallint,
  add column candidate_transaction_id uuid references public.transactions (id) on delete set null;

-- Limite de taxa do endpoint público, persistido porque o servidor não guarda estado.
alter table public.capture_tokens
  add column window_started_at timestamptz,
  add column window_count integer not null default 0;

-- ---------------------------------------------------------------------------
-- Categorias que faltam na lista do agente. Nada é renomeado nem apagado.
-- ---------------------------------------------------------------------------
create function public._agent_seed_categories(p_user uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.transaction_categories (user_id, name, slug, kind, icon, color, is_system)
  select p_user, s.name, s.slug, s.kind::public.category_kind, s.icon, s.color, true
    from (values
      ('Mercado',          'mercado',       'expense', 'shopping-cart',   '#fb923c'),
      ('Restaurantes',     'restaurantes',  'expense', 'utensils',        '#fb923c'),
      ('Combustível',      'combustivel',   'expense', 'car',             '#fbbf24'),
      ('Tecnologia',       'tecnologia',    'expense', 'laptop',          '#60a5fa'),
      ('Viagens',          'viagens',       'expense', 'plane',           '#2dd4bf'),
      ('Serviços',         'servicos',      'expense', 'zap',             '#a78bfa'),
      ('Impostos',         'impostos',      'expense', 'receipt',         '#f87171'),
      ('Tarifas bancárias','tarifas',       'expense', 'banknote',        '#a3a3a3')
    ) as s (name, slug, kind, icon, color)
  on conflict (user_id, slug) do nothing;
$$;

select public._agent_seed_categories(p.id) from public.profiles p;

-- Novos usuários também as recebem, sem reescrever handle_new_user.
create function public.profiles_seed_agent_categories()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._agent_seed_categories(new.id);
  return new;
end;
$$;

create trigger profiles_seed_agent_categories
  after insert on public.profiles
  for each row execute function public.profiles_seed_agent_categories();

-- ---------------------------------------------------------------------------
-- Normalização e semelhança de descrições.
-- ---------------------------------------------------------------------------
create function public.agent_normalize(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(string_agg(u.t, ' ' order by u.ord), '')
    from unnest(string_to_array(
           regexp_replace(
             translate(lower(coalesce(p_text, '')),
               'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
             '[^a-z0-9]+', ' ', 'g'
           ), ' ')) with ordinality as u(t, ord)
   where u.t <> ''
     -- Ruído comum em extratos: não ajuda a identificar o estabelecimento.
     and u.t <> all (array[
       'pix', 'ted', 'doc', 'compra', 'compras', 'cartao', 'debito', 'credito', 'pag', 'pgto', 'pagto',
       'pagamento', 'enviado', 'recebido', 'transferencia', 'ltda', 'me', 'sa', 'eireli', 'com', 'br',
       'sp', 'rj', 'mg', 'parcela', 'de', 'da', 'do', 'em', 'no', 'na', 'para'
     ]);
$$;

create function public.agent_tokens(p_text text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct t), '{}')
    from unnest(string_to_array(public.agent_normalize(p_text), ' ')) as t
   where char_length(t) >= 3 and t !~ '^[0-9]+$';
$$;

-- Coeficiente de sobreposição: 1 quando um nome está contido no outro.
create function public.agent_similarity(p_a text, p_b text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  with a as (select public.agent_tokens(p_a) as t),
       b as (select public.agent_tokens(p_b) as t)
  select case
    when cardinality(a.t) = 0 or cardinality(b.t) = 0 then 0
    else (select count(*) from unnest(a.t) x where x = any(b.t))::numeric
         / least(cardinality(a.t), cardinality(b.t))
  end
  from a, b;
$$;

-- ---------------------------------------------------------------------------
-- Classificador: regra sua > memória > dicionário. Devolve a sugestão e a confiança.
-- ---------------------------------------------------------------------------
create table public.agent_keywords (
  keyword  text primary key,
  slug     text not null,
  kind     public.category_kind not null,
  confidence smallint not null
);
alter table public.agent_keywords enable row level security;
revoke all on public.agent_keywords from anon, authenticated;

insert into public.agent_keywords (keyword, slug, kind, confidence) values
  ('uber', 'transporte', 'expense', 90), ('99app', 'transporte', 'expense', 90), ('99pop', 'transporte', 'expense', 90),
  ('metro', 'transporte', 'expense', 75), ('estacionamento', 'transporte', 'expense', 85), ('pedagio', 'transporte', 'expense', 90),
  ('posto', 'combustivel', 'expense', 75), ('shell', 'combustivel', 'expense', 85), ('ipiranga', 'combustivel', 'expense', 85), ('petrobras', 'combustivel', 'expense', 85), ('combustivel', 'combustivel', 'expense', 90),
  ('supermercado', 'mercado', 'expense', 90), ('mercado', 'mercado', 'expense', 75), ('carrefour', 'mercado', 'expense', 90), ('assai', 'mercado', 'expense', 90), ('atacadao', 'mercado', 'expense', 90), ('hortifruti', 'mercado', 'expense', 85), ('pao acucar', 'mercado', 'expense', 90),
  ('ifood', 'restaurantes', 'expense', 90), ('rappi', 'restaurantes', 'expense', 80), ('restaurante', 'restaurantes', 'expense', 90), ('lanchonete', 'restaurantes', 'expense', 85), ('pizzaria', 'restaurantes', 'expense', 90), ('churrascaria', 'restaurantes', 'expense', 90), ('hamburgueria', 'restaurantes', 'expense', 90), ('mcdonald', 'restaurantes', 'expense', 90), ('burger king', 'restaurantes', 'expense', 90),
  ('padaria', 'alimentacao', 'expense', 85), ('cafeteria', 'alimentacao', 'expense', 85), ('starbucks', 'alimentacao', 'expense', 85),
  ('farmacia', 'saude', 'expense', 85), ('drogaria', 'saude', 'expense', 90), ('drogasil', 'saude', 'expense', 90), ('hospital', 'saude', 'expense', 90), ('clinica', 'saude', 'expense', 80), ('laboratorio', 'saude', 'expense', 75), ('dentista', 'saude', 'expense', 90), ('unimed', 'saude', 'expense', 90),
  ('netflix', 'assinaturas', 'expense', 95), ('spotify', 'assinaturas', 'expense', 95), ('disney', 'assinaturas', 'expense', 85), ('prime video', 'assinaturas', 'expense', 90), ('youtube premium', 'assinaturas', 'expense', 95), ('hbo', 'assinaturas', 'expense', 85), ('icloud', 'assinaturas', 'expense', 95), ('google one', 'assinaturas', 'expense', 90),
  ('apple', 'tecnologia', 'expense', 70), ('kabum', 'tecnologia', 'expense', 90), ('microsoft', 'tecnologia', 'expense', 80), ('openai', 'tecnologia', 'expense', 90), ('anthropic', 'tecnologia', 'expense', 90),
  ('escola', 'educacao', 'expense', 85), ('faculdade', 'educacao', 'expense', 90), ('universidade', 'educacao', 'expense', 90), ('udemy', 'educacao', 'expense', 95), ('curso', 'educacao', 'expense', 75),
  ('cinema', 'lazer', 'expense', 90), ('ingresso', 'lazer', 'expense', 80), ('steam', 'lazer', 'expense', 85),
  ('latam', 'viagens', 'expense', 90), ('gol linhas', 'viagens', 'expense', 90), ('azul linhas', 'viagens', 'expense', 90), ('hotel', 'viagens', 'expense', 85), ('booking', 'viagens', 'expense', 90), ('airbnb', 'viagens', 'expense', 90),
  ('aluguel', 'moradia', 'expense', 90), ('condominio', 'moradia', 'expense', 90),
  ('energia', 'contas-fixas', 'expense', 75), ('enel', 'contas-fixas', 'expense', 90), ('cemig', 'contas-fixas', 'expense', 90), ('sabesp', 'contas-fixas', 'expense', 90), ('vivo', 'contas-fixas', 'expense', 80), ('claro', 'contas-fixas', 'expense', 80), ('tim', 'contas-fixas', 'expense', 75), ('internet', 'contas-fixas', 'expense', 75),
  ('amazon', 'compras', 'expense', 75), ('mercadolivre', 'compras', 'expense', 85), ('mercado livre', 'compras', 'expense', 85), ('magalu', 'compras', 'expense', 85), ('shopee', 'compras', 'expense', 85), ('aliexpress', 'compras', 'expense', 85), ('shein', 'compras', 'expense', 85),
  ('iptu', 'impostos', 'expense', 95), ('ipva', 'impostos', 'expense', 95), ('darf', 'impostos', 'expense', 95), ('das simples', 'impostos', 'expense', 90), ('receita federal', 'impostos', 'expense', 90),
  ('tarifa', 'tarifas', 'expense', 90), ('anuidade', 'tarifas', 'expense', 90), ('iof', 'tarifas', 'expense', 90), ('juros', 'tarifas', 'expense', 80),
  ('mcdonalds', 'restaurantes', 'expense', 90),
  ('salario', 'salario', 'income', 95), ('folha', 'salario', 'income', 85), ('rendimento', 'investimentos', 'income', 85), ('dividendos', 'investimentos', 'income', 90), ('resgate', 'investimentos', 'income', 75);

create function public._agent_classify(p_user uuid, p_description text, p_income boolean)
returns table (category_id uuid, confidence smallint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.category_kind := case when p_income then 'income'::public.category_kind else 'expense'::public.category_kind end;
  v_text text := public.agent_normalize(p_description);
  v_id uuid;
  v_source public.category_source;
begin
  -- 1. Regra criada por uma correção sua.
  select r.category_id into v_id
    from public.category_rules r
    join public.transaction_categories c on c.id = r.category_id
   where r.user_id = p_user and not c.archived and c.kind = v_kind
     and ((r.match_type = 'contains' and position(lower(r.pattern) in v_text) > 0)
          or (r.match_type = 'starts_with' and v_text like lower(r.pattern) || '%'))
   order by r.priority, char_length(r.pattern) desc
   limit 1;
  if v_id is not null then
    return query select v_id, 100::smallint;
    return;
  end if;

  -- 2. O que aconteceu da última vez com a mesma descrição.
  select t.category_id, t.category_source into v_id, v_source
    from public.transactions t
    join public.transaction_categories c on c.id = t.category_id
   where t.user_id = p_user and not c.archived and c.kind = v_kind
     and public.agent_normalize(t.description) = v_text
     and v_text <> ''
   order by (t.category_source = 'manual') desc nulls last, t.posted_at desc
   limit 1;
  if v_id is not null then
    return query select v_id, (case when v_source = 'manual' then 95 else 80 end)::smallint;
    return;
  end if;

  -- 3. Dicionário: a palavra-chave mais longa vence.
  return query
    select c.id, k.confidence
      from public.agent_keywords k
      join public.transaction_categories c
        on c.user_id = p_user and c.slug = k.slug and c.kind = k.kind and not c.archived
     where k.kind = v_kind
       and (' ' || v_text || ' ') like ('% ' || k.keyword || ' %')
     order by char_length(k.keyword) desc, k.confidence desc
     limit 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Toda correção sua vira regra. O que é manual nunca é alterado pelo agente.
-- ---------------------------------------------------------------------------
create unique index category_rules_user_pattern_idx
  on public.category_rules (user_id, lower(pattern));

create function public.transactions_learn_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pattern text := public.agent_normalize(new.description);
begin
  if new.category_id is null or new.category_source is distinct from 'manual'::public.category_source
     or new.category_id is not distinct from old.category_id
     or char_length(v_pattern) < 3 then
    return null;
  end if;

  insert into public.category_rules (user_id, category_id, pattern, match_type, priority)
  values (new.user_id, new.category_id, v_pattern, 'contains', 10)
  on conflict (user_id, lower(pattern)) do update set category_id = excluded.category_id;

  return null;
end;
$$;

create trigger transactions_learn_category
  after update of category_id on public.transactions
  for each row execute function public.transactions_learn_category();

-- ---------------------------------------------------------------------------
-- Estornos em cartão reduzem a fatura. O restante das regras não muda.
-- ---------------------------------------------------------------------------
create or replace function public.transactions_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_is_new boolean := tg_op = 'INSERT';
  v_category_kind text;
  v_category_archived boolean;
  v_invoice_card uuid;
begin
  if v_is_new or new.amount_cents <> old.amount_cents or new.kind <> old.kind then
    if new.amount_cents = 0
       or (new.kind::text = 'income' and new.amount_cents < 0)
       or (new.kind::text = 'expense' and new.amount_cents > 0) then
      raise exception 'amount does not match kind' using errcode = 'WL004';
    end if;
  end if;

  if new.kind::text = 'transfer' then
    if (v_is_new or old.kind::text <> 'transfer' or new.transfer_group_id is distinct from old.transfer_group_id)
       and new.transfer_group_id is null then
      raise exception 'transfer needs a group' using errcode = 'WL005';
    end if;
  elsif new.transfer_group_id is not null then
    raise exception 'only transfers have a group' using errcode = 'WL005';
  end if;

  if new.category_id is not null
     and (v_is_new or new.category_id is distinct from old.category_id or new.kind <> old.kind) then
    if new.kind::text in ('transfer', 'invoice_payment') then
      raise exception 'this kind has no category' using errcode = 'WL001';
    end if;

    select c.kind::text, c.archived
      into v_category_kind, v_category_archived
      from public.transaction_categories c
     where c.id = new.category_id;

    if new.kind::text in ('income', 'expense') and v_category_kind <> new.kind::text then
      raise exception 'category does not match kind' using errcode = 'WL001';
    end if;

    if (v_is_new or new.category_id is distinct from old.category_id) and v_category_archived then
      raise exception 'category is archived' using errcode = 'WL002';
    end if;
  end if;

  if new.account_id is not null
     and (v_is_new or new.account_id is distinct from old.account_id)
     and exists (
       select 1 from public.bank_accounts a where a.id = new.account_id and a.archived
     ) then
    raise exception 'account is archived' using errcode = 'WL003';
  end if;

  if v_is_new then
    if new.card_id is not null and new.account_id is null
       and (new.kind::text not in ('expense', 'refund') or new.invoice_id is null) then
      raise exception 'card entry needs an invoice' using errcode = 'WL010';
    end if;

    if new.kind::text = 'invoice_payment'
       and (new.account_id is null or new.invoice_id is null) then
      raise exception 'invoice payment needs account and invoice' using errcode = 'WL010';
    end if;

    if new.invoice_id is not null then
      select i.card_id into v_invoice_card
        from public.card_invoices i where i.id = new.invoice_id;
      if v_invoice_card is distinct from new.card_id then
        raise exception 'invoice belongs to another card' using errcode = 'WL010';
      end if;
    end if;

    if new.card_id is not null and new.account_id is null and exists (
      select 1 from public.credit_cards c where c.id = new.card_id and c.archived
    ) then
      raise exception 'card is archived' using errcode = 'WL009';
    end if;
  elsif new.card_id is distinct from old.card_id
     or new.invoice_id is distinct from old.invoice_id
     or new.installment_id is distinct from old.installment_id then
    raise exception 'card links cannot change' using errcode = 'WL010';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Compra no cartão: agora quem chama informa a origem da categoria. Só o que você
-- escolheu conta como manual. Corrige lançamentos capturados marcados como manuais.
-- ---------------------------------------------------------------------------
drop function public._insert_card_purchase(uuid, uuid, text, bigint, integer, date, uuid, text, text);

create function public._insert_card_purchase(
  p_user uuid, p_card uuid, p_description text, p_total_cents bigint,
  p_installments integer, p_date date, p_category uuid, p_notes text, p_dedupe text,
  p_category_source public.category_source default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closing_day integer;
  v_archived boolean;
  v_base bigint;
  v_first_reference date;
  v_reference date;
  v_plan uuid;
  v_first uuid;
  v_id uuid;
  v_amount bigint;
begin
  select c.closing_day, c.archived into v_closing_day, v_archived
    from public.credit_cards c where c.id = p_card and c.user_id = p_user;
  if not found then
    raise exception 'card not found' using errcode = 'P0002';
  end if;
  if v_archived then
    raise exception 'card is archived' using errcode = 'WL009';
  end if;
  if p_total_cents is null or p_total_cents <= 0 then
    raise exception 'amount must be positive' using errcode = 'WL004';
  end if;
  if p_installments is null or p_installments < 1 or p_installments > 48 then
    raise exception 'invalid installments' using errcode = 'WL012';
  end if;
  if p_total_cents < p_installments then
    raise exception 'installment below one cent' using errcode = 'WL012';
  end if;

  v_base := p_total_cents / p_installments;
  v_first_reference := public.card_invoice_month(p_date, v_closing_day);

  if p_installments > 1 then
    insert into public.card_installments
      (user_id, card_id, description, total_cents, installment_cents,
       installments_total, first_invoice_month)
    values
      (p_user, p_card, p_description, p_total_cents, v_base, p_installments, v_first_reference)
    returning id into v_plan;
  end if;

  for i in 1..p_installments loop
    v_reference := (v_first_reference + make_interval(months => i - 1))::date;
    v_amount := v_base + case when i = 1 then p_total_cents - v_base * p_installments else 0 end;

    insert into public.transactions
      (user_id, card_id, invoice_id, installment_id, installment_number, installment_total,
       category_id, category_source, posted_at, competence_date, description, amount_cents,
       kind, payment_method, notes, dedupe_hash)
    values
      (p_user, p_card, public._ensure_card_invoice(p_user, p_card, v_reference), v_plan,
       case when p_installments > 1 then i end,
       case when p_installments > 1 then p_installments end,
       p_category, case when p_category is not null then p_category_source end,
       (p_date + make_interval(months => i - 1))::date, v_reference, p_description, -v_amount,
       'expense', 'credit', p_notes, p_dedupe || ':' || i::text)
    returning id into v_id;

    if i = 1 then
      v_first := v_id;
    end if;
  end loop;

  if v_plan is not null then
    update public.card_installments set transaction_id = v_first where id = v_plan;
  end if;

  return v_first;
end;
$$;

revoke all on function public._insert_card_purchase(uuid, uuid, text, bigint, integer, date, uuid, text, text, public.category_source)
  from public, anon, authenticated;

update public.transactions
   set category_source = 'rule'
 where category_source = 'manual' and notes like 'Captura automática%';

-- ---------------------------------------------------------------------------
-- Registro em audit_logs: é a linha do tempo do agente.
-- ---------------------------------------------------------------------------
create function public._agent_log(
  p_user uuid, p_event text, p_entity_type text, p_entity_id text, p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_logs (user_id, event, entity_type, entity_id, metadata)
  values (p_user, p_event, p_entity_type, p_entity_id, p_metadata);
$$;

-- ---------------------------------------------------------------------------
-- Quem chama: limite de taxa só para o endpoint público (por token, não para a Pluggy).
-- ---------------------------------------------------------------------------
create function public._capture_rate_limit(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.capture_tokens t
     set window_started_at = case
           when t.window_started_at is null or t.window_started_at < now() - interval '1 minute'
             then now() else t.window_started_at end,
         window_count = case
           when t.window_started_at is null or t.window_started_at < now() - interval '1 minute'
             then 1 else t.window_count + 1 end
   where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  returning t.window_count into v_count;

  if v_count > 60 then
    raise exception 'too many requests' using errcode = 'WL014';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grava o lançamento já decidido.
-- ---------------------------------------------------------------------------
drop function public._capture_post(uuid, text, bigint, date, public.payment_method, uuid, uuid, text);

create function public._capture_post(
  p_user uuid, p_description text, p_amount_cents bigint, p_date date,
  p_method public.payment_method, p_account uuid, p_card uuid, p_location text,
  p_category uuid, p_kind text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_notes text := 'Captura automática' || coalesce(' · ' || p_location, '');
  v_dedupe text := 'capture:' || gen_random_uuid()::text;
  v_kind text := coalesce(p_kind, case when p_amount_cents > 0 then 'income' else 'expense' end);
  v_id uuid;
begin
  if p_card is not null then
    return public._insert_card_purchase(
      p_user, p_card, p_description, -p_amount_cents, 1, p_date, p_category, v_notes, v_dedupe,
      'rule'::public.category_source
    );
  end if;

  insert into public.transactions
    (user_id, account_id, category_id, category_source, posted_at, description,
     amount_cents, kind, payment_method, notes, dedupe_hash)
  values
    (p_user, p_account, p_category,
     case when p_category is not null then 'rule'::public.category_source end,
     p_date, p_description, p_amount_cents, v_kind::public.tx_kind, p_method, v_notes, v_dedupe)
  returning id into v_id;

  return v_id;
end;
$$;

-- Estorno no cartão: entra na fatura do mês, sem deixá-la negativa.
create function public._capture_card_refund(
  p_user uuid, p_card uuid, p_description text, p_amount_cents bigint, p_date date, p_location text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closing_day integer;
  v_invoice uuid;
  v_total bigint;
  v_id uuid;
begin
  select c.closing_day into v_closing_day
    from public.credit_cards c where c.id = p_card and c.user_id = p_user;

  v_invoice := public._ensure_card_invoice(p_user, p_card, public.card_invoice_month(p_date, v_closing_day));

  select i.total_cents into v_total from public.card_invoices i where i.id = v_invoice for update;
  if v_total < p_amount_cents then
    return null;
  end if;

  insert into public.transactions
    (user_id, card_id, invoice_id, posted_at, competence_date, description, amount_cents,
     kind, payment_method, notes, dedupe_hash)
  values
    (p_user, p_card, v_invoice, p_date, p_date, p_description, p_amount_cents, 'refund', 'credit',
     'Captura automática' || coalesce(' · ' || p_location, ''), 'capture:' || gen_random_uuid()::text)
  returning id into v_id;
  return v_id;
end;
$$;

-- Pagamento de fatura identificado no extrato da conta: registra, sem pagar nada no banco.
create function public._capture_invoice_payment(
  p_user uuid, p_invoice uuid, p_account uuid, p_amount_cents bigint, p_date date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice record;
  v_id uuid;
begin
  select i.id, i.card_id, i.total_cents, i.paid_cents, c.name as card_name into v_invoice
    from public.card_invoices i
    join public.credit_cards c on c.id = i.card_id
   where i.id = p_invoice and i.user_id = p_user
     for update of i;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if abs(p_amount_cents) > v_invoice.total_cents - v_invoice.paid_cents then
    raise exception 'payment above invoice balance' using errcode = 'WL007';
  end if;

  insert into public.transactions
    (user_id, account_id, card_id, invoice_id, posted_at, description, amount_cents, kind, notes, dedupe_hash)
  values
    (p_user, p_account, v_invoice.card_id, p_invoice, p_date,
     'Pagamento de fatura ' || v_invoice.card_name, -abs(p_amount_cents), 'invoice_payment',
     'Captura automática', 'capture:' || gen_random_uuid()::text)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Entrada de um evento. Só decide e registra: nunca movimenta dinheiro.
-- ---------------------------------------------------------------------------
drop function public.ingest_capture(text, text, text, text, bigint, date, text, text, text, uuid, uuid, text, text);

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
  p_reason       text,
  p_intent       text default 'normal'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._capture_user(p_token);
  v_settings public.agent_settings;
  v_method public.payment_method;
  v_description text := left(btrim(coalesce(p_description, '')), 200);
  v_location text := nullif(left(btrim(coalesce(p_location, '')), 200), '');
  v_hint text := nullif(lower(btrim(coalesce(p_hint, ''))), '');
  v_intent text := coalesce(p_intent, 'normal');
  v_account uuid;
  v_card uuid;
  v_ids uuid[];
  v_reason text := p_reason;
  v_tx uuid;
  v_candidate uuid;
  v_candidate_description text;
  v_status text;
  v_category uuid;
  v_confidence smallint;
  v_suggested uuid;
  v_invoice uuid;
  v_generic boolean;
begin
  if p_source not in ('apple_pay', 'notification', 'sms', 'email', 'pluggy', 'ofx', 'csv') then
    raise exception 'invalid source' using errcode = 'WL013';
  end if;
  if v_intent not in ('normal', 'invoice_payment', 'refund', 'possible_transfer') then
    raise exception 'invalid intent' using errcode = 'WL013';
  end if;
  if p_amount_cents is null or p_amount_cents = 0 or abs(p_amount_cents) > 100000000000000 then
    raise exception 'invalid amount' using errcode = 'WL004';
  end if;
  if p_token is not null and p_source not in ('pluggy', 'ofx', 'csv') then
    perform public._capture_rate_limit(p_token);
  end if;

  v_generic := v_description = '' or lower(v_description) in ('entrada capturada', 'saída capturada', 'compra capturada', 'pix recebido', 'pix enviado');
  if v_description = '' then
    v_description := case when p_amount_cents > 0 then 'Entrada capturada' else 'Saída capturada' end;
  end if;
  if p_method in ('pix', 'cash', 'debit', 'credit', 'boleto', 'transfer', 'other') then
    v_method := p_method::public.payment_method;
  end if;

  select * into v_settings from public.agent_settings s where s.user_id = v_user;

  -- Mesmo evento reenviado.
  if p_external_ref is not null and exists (
    select 1 from public.capture_events e
     where e.user_id = v_user and e.external_ref = p_external_ref
  ) then
    perform public._agent_log(v_user, 'agent.duplicate_blocked', 'capture_event', p_external_ref,
      jsonb_build_object('description', v_description, 'amount_cents', p_amount_cents));
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

  -- Destino: explícito (Pluggy, arquivo) ou deduzido da dica (nome ou últimos dígitos).
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
  if v_reason is null and v_settings.paused then
    v_reason := 'Agente pausado: aguardando sua decisão';
  end if;
  if v_reason is null and coalesce(v_settings.auto_register, true) = false then
    v_reason := 'Registro automático desligado';
  end if;

  -- Crédito em cartão sem ser estorno identificado: pede revisão.
  if v_reason is null and v_card is not null and p_amount_cents > 0 and v_intent <> 'refund' then
    v_reason := 'Estorno ou crédito no cartão';
  end if;

  -- Pagamento de fatura no extrato: só concilia sozinho com correspondência exata e única.
  if v_reason is null and v_intent = 'invoice_payment' and v_account is not null then
    select t.id into v_candidate
      from public.transactions t
     where t.user_id = v_user and t.account_id = v_account
       and t.kind::text = 'invoice_payment' and t.amount_cents = p_amount_cents
       and t.posted_at between p_date - 3 and p_date + 3
       and not exists (select 1 from public.capture_events e where e.transaction_id = t.id and e.source = p_source)
     limit 1;

    if v_candidate is null then
      select array_agg(i.id) into v_ids
        from public.card_invoices i
       where i.user_id = v_user and i.total_cents - i.paid_cents = abs(p_amount_cents);
      if cardinality(v_ids) = 1 then
        v_invoice := v_ids[1];
      else
        v_reason := 'Pagamento de fatura: escolha a fatura';
      end if;
    end if;
  end if;

  -- Classificação: regra sua > memória > dicionário.
  if v_intent = 'normal' then
    select c.category_id, c.confidence into v_suggested, v_confidence
      from public._agent_classify(v_user, v_description, p_amount_cents > 0) c;
    if v_suggested is not null and coalesce(v_settings.auto_categorize, true)
       and v_confidence >= coalesce(v_settings.min_confidence, 70) then
      v_category := v_suggested;
    end if;
  end if;

  -- Duplicidade em normal: mesmo valor e destino, em até um dia, ainda não usado por
  -- esta fonte. Valor e data não bastam: sem semelhança de descrição, você decide.
  if v_reason is null and v_intent = 'normal' then
    select t.id, t.description into v_candidate, v_candidate_description
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
     order by public.agent_similarity(t.description, v_description) desc,
              abs(t.posted_at - p_date), t.created_at
     limit 1;

    if v_candidate is not null
       and not v_generic
       and cardinality(public.agent_tokens(v_description)) > 0
       and cardinality(public.agent_tokens(v_candidate_description)) > 0
       and public.agent_similarity(v_candidate_description, v_description) < 0.5 then
      v_reason := 'Possível duplicidade de “' || v_candidate_description || '”';
    end if;
  end if;

  -- Transferência entre contas próprias: há o lado oposto em outra conta sua?
  if v_reason is null and v_candidate is null and v_account is not null
     and v_intent in ('normal', 'possible_transfer')
     and (v_intent = 'possible_transfer' or v_method in ('pix', 'transfer')) then
    select t.id into v_tx
      from public.transactions t
     where t.user_id = v_user
       and t.amount_cents = -p_amount_cents
       and t.account_id is not null and t.account_id <> v_account
       and t.kind::text in ('income', 'expense')
       and t.posted_at between p_date - 1 and p_date + 1
     order by abs(t.posted_at - p_date)
     limit 1;

    if v_tx is not null then
      v_candidate := v_tx;
      v_tx := null;
      v_reason := 'Possível transferência entre suas contas';
      v_intent := 'possible_transfer';
    elsif v_intent = 'possible_transfer' then
      v_reason := 'Possível transferência entre suas contas';
    end if;
  end if;

  if v_reason is not null then
    insert into public.capture_events
      (user_id, source, external_ref, description, normalized_description, amount_cents, event_date,
       payment_method, location, status, reason, intent, account_id, card_id,
       suggested_category_id, confidence, candidate_transaction_id)
    values
      (v_user, p_source, p_external_ref, v_description, public.agent_normalize(v_description),
       p_amount_cents, p_date, v_method, v_location, 'pending', v_reason, v_intent, v_account, v_card,
       v_suggested, v_confidence, v_candidate);

    perform public._agent_log(v_user, 'agent.needs_review', 'capture_event', null,
      jsonb_build_object('description', v_description, 'amount_cents', p_amount_cents, 'reason', v_reason));

    return jsonb_build_object('status', 'pending', 'reason', v_reason);
  end if;

  if v_candidate is not null then
    v_tx := v_candidate;
    v_status := 'matched';
  elsif v_invoice is not null then
    v_tx := public._capture_invoice_payment(v_user, v_invoice, v_account, p_amount_cents, p_date);
    v_status := 'created';
  elsif v_intent = 'refund' and v_card is not null then
    v_tx := public._capture_card_refund(v_user, v_card, v_description, p_amount_cents, p_date, v_location);
    if v_tx is null then
      insert into public.capture_events
        (user_id, source, external_ref, description, normalized_description, amount_cents, event_date,
         payment_method, location, status, reason, intent, card_id)
      values
        (v_user, p_source, p_external_ref, v_description, public.agent_normalize(v_description),
         p_amount_cents, p_date, v_method, v_location, 'pending',
         'Estorno maior que a fatura do mês', v_intent, v_card);
      return jsonb_build_object('status', 'pending', 'reason', 'Estorno maior que a fatura do mês');
    end if;
    v_status := 'created';
  elsif v_intent = 'refund' then
    v_tx := public._capture_post(
      v_user, v_description, p_amount_cents, p_date, v_method, v_account, null, v_location, null, 'refund'
    );
    v_status := 'created';
  else
    v_tx := public._capture_post(
      v_user, v_description, p_amount_cents, p_date, v_method, v_account, v_card, v_location, v_category
    );
    v_status := 'created';
  end if;

  insert into public.capture_events
    (user_id, source, external_ref, description, normalized_description, amount_cents, event_date,
     payment_method, location, transaction_id, status, intent, account_id, card_id,
     suggested_category_id, confidence)
  values
    (v_user, p_source, p_external_ref, v_description, public.agent_normalize(v_description),
     p_amount_cents, p_date, v_method, v_location, v_tx, v_status, v_intent, v_account, v_card,
     v_suggested, v_confidence);

  perform public._agent_log(
    v_user,
    case
      when v_status = 'matched' then 'agent.reconciled'
      when v_invoice is not null then 'agent.invoice_payment_registered'
      when v_intent = 'refund' then 'agent.refund_registered'
      when v_card is not null then 'agent.card_purchase_registered'
      when v_method = 'pix' and p_amount_cents > 0 then 'agent.pix_received'
      when v_method = 'pix' then 'agent.pix_sent'
      else 'agent.transaction_registered'
    end,
    'transaction', v_tx::text,
    jsonb_build_object('description', v_description, 'amount_cents', p_amount_cents, 'source', p_source)
  );

  set constraints all immediate;
  return jsonb_build_object('status', v_status, 'transaction_id', v_tx);
end;
$$;

-- ---------------------------------------------------------------------------
-- Revisão.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_capture(p_event uuid, p_account uuid, p_card uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_event public.capture_events;
  v_tx uuid;
  v_category uuid;
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

  if v_event.intent = 'invoice_payment' then
    raise exception 'use the invoice flow' using errcode = 'WL013';
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

  -- A sugestão só é aplicada se a categoria continuar compatível.
  select c.id into v_category from public.transaction_categories c
   where c.id = v_event.suggested_category_id and not c.archived
     and c.kind::text = case when v_event.amount_cents > 0 then 'income' else 'expense' end;

  v_tx := public._capture_post(
    v_user, v_event.description, v_event.amount_cents, v_event.event_date,
    v_event.payment_method, p_account, p_card, v_event.location, v_category,
    case when v_event.intent = 'refund' and p_account is not null then 'refund' end
  );

  update public.capture_events
     set status = 'resolved', transaction_id = v_tx, candidate_transaction_id = null
   where id = p_event;

  perform public._agent_log(v_user, 'agent.review_resolved', 'transaction', v_tx::text,
    jsonb_build_object('description', v_event.description, 'amount_cents', v_event.amount_cents));

  set constraints all immediate;
  return v_tx;
end;
$$;

-- "É o mesmo lançamento": liga o evento ao que já existe, sem gravar de novo.
create function public.confirm_capture_match(p_event uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_event public.capture_events;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select * into v_event from public.capture_events e
   where e.id = p_event and e.user_id = v_user and e.status = 'pending'
     for update;
  if not found or v_event.candidate_transaction_id is null then
    raise exception 'event not found' using errcode = 'P0002';
  end if;

  update public.capture_events
     set status = 'matched', transaction_id = v_event.candidate_transaction_id,
         candidate_transaction_id = null
   where id = p_event;

  perform public._agent_log(v_user, 'agent.reconciled', 'transaction', v_event.candidate_transaction_id::text,
    jsonb_build_object('description', v_event.description, 'amount_cents', v_event.amount_cents));

  return v_event.candidate_transaction_id;
end;
$$;

-- Registra o pagamento de fatura escolhido. Só organiza: o pagamento já aconteceu no banco.
create function public.resolve_capture_invoice(p_event uuid, p_invoice uuid)
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
  if not found or v_event.intent <> 'invoice_payment' or v_event.account_id is null then
    raise exception 'event not found' using errcode = 'P0002';
  end if;

  v_tx := public._capture_invoice_payment(
    v_user, p_invoice, v_event.account_id, v_event.amount_cents, v_event.event_date
  );

  update public.capture_events
     set status = 'resolved', transaction_id = v_tx
   where id = p_event;

  perform public._agent_log(v_user, 'agent.invoice_payment_registered', 'transaction', v_tx::text,
    jsonb_build_object('description', v_event.description, 'amount_cents', v_event.amount_cents));

  return v_tx;
end;
$$;

-- "É transferência entre minhas contas": converte o par, sem receita nem despesa.
create function public.link_own_transfer(p_event uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_event public.capture_events;
  v_other public.transactions;
  v_group uuid := gen_random_uuid();
  v_date date;
  v_tx uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select * into v_event from public.capture_events e
   where e.id = p_event and e.user_id = v_user and e.status = 'pending'
     for update;
  if not found or v_event.account_id is null or v_event.candidate_transaction_id is null then
    raise exception 'event not found' using errcode = 'P0002';
  end if;

  select * into v_other from public.transactions t
   where t.id = v_event.candidate_transaction_id and t.user_id = v_user
     and t.account_id is not null and t.account_id <> v_event.account_id
     and t.amount_cents = -v_event.amount_cents
     and t.kind::text in ('income', 'expense')
     for update;
  if not found then
    raise exception 'counterpart not found' using errcode = 'P0002';
  end if;

  v_date := least(v_event.event_date, v_other.posted_at);

  update public.transactions
     set kind = 'transfer', category_id = null, category_source = null,
         transfer_group_id = v_group, posted_at = v_date, payment_method = coalesce(payment_method, 'transfer')
   where id = v_other.id;

  insert into public.transactions
    (user_id, account_id, posted_at, description, amount_cents, kind, payment_method, notes,
     transfer_group_id, dedupe_hash)
  values
    (v_user, v_event.account_id, v_date, v_event.description, v_event.amount_cents, 'transfer',
     coalesce(v_event.payment_method, 'transfer'), 'Captura automática', v_group,
     'capture:' || gen_random_uuid()::text)
  returning id into v_tx;

  update public.capture_events
     set status = 'resolved', transaction_id = v_tx, candidate_transaction_id = null
   where id = p_event;

  perform public._agent_log(v_user, 'agent.own_transfer_linked', 'transfer', v_group::text,
    jsonb_build_object('description', v_event.description, 'amount_cents', abs(v_event.amount_cents)));

  set constraints all immediate;
  return v_group;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execuções: início com trava e recuperação de execução interrompida.
-- ---------------------------------------------------------------------------
create function public.agent_start_run(p_token text, p_kind text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._capture_user(p_token);
  v_id uuid;
begin
  -- Execução presa há mais de 15 minutos foi interrompida: libera a trava.
  update public.agent_runs
     set status = 'failed', finished_at = now(), error_code = 'interrupted'
   where user_id = v_user and kind = p_kind and status = 'running'
     and started_at < now() - interval '15 minutes';

  insert into public.agent_runs (user_id, kind) values (v_user, p_kind)
  on conflict (user_id, kind) where status = 'running' do nothing
  returning id into v_id;

  return v_id;
end;
$$;

create function public.agent_finish_run(
  p_token text, p_run uuid, p_status text, p_summary jsonb, p_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._capture_user(p_token);
begin
  update public.agent_runs
     set status = p_status, finished_at = now(), summary = coalesce(p_summary, '{}'::jsonb),
         error_code = p_error_code
   where id = p_run and user_id = v_user and status = 'running';

  perform public._agent_log(v_user, 'agent.run_' || p_status, 'agent_run', p_run::text,
    jsonb_build_object('summary', p_summary, 'error_code', p_error_code));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
revoke all on function public._agent_seed_categories(uuid) from public, anon, authenticated;
revoke all on function public.profiles_seed_agent_categories() from public, anon, authenticated;
revoke all on function public._agent_classify(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.transactions_learn_category() from public, anon, authenticated;
revoke all on function public.transactions_record_revision() from public, anon, authenticated;
revoke all on function public._agent_log(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public._capture_rate_limit(text) from public, anon, authenticated;
revoke all on function public._capture_post(uuid, text, bigint, date, public.payment_method, uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public._capture_card_refund(uuid, uuid, text, bigint, date, text) from public, anon, authenticated;
revoke all on function public._capture_invoice_payment(uuid, uuid, uuid, bigint, date) from public, anon, authenticated;

revoke all on function public.ingest_capture(text, text, text, text, bigint, date, text, text, text, uuid, uuid, text, text, text) from public;
grant execute on function public.ingest_capture(text, text, text, text, bigint, date, text, text, text, uuid, uuid, text, text, text) to anon, authenticated;

revoke all on function public.agent_start_run(text, text) from public;
revoke all on function public.agent_finish_run(text, uuid, text, jsonb, text) from public;
grant execute on function public.agent_start_run(text, text) to anon, authenticated;
grant execute on function public.agent_finish_run(text, uuid, text, jsonb, text) to anon, authenticated;

revoke all on function public.confirm_capture_match(uuid) from public, anon;
revoke all on function public.resolve_capture_invoice(uuid, uuid) from public, anon;
revoke all on function public.link_own_transfer(uuid) from public, anon;
grant execute on function public.confirm_capture_match(uuid) to authenticated;
grant execute on function public.resolve_capture_invoice(uuid, uuid) to authenticated;
grant execute on function public.link_own_transfer(uuid) to authenticated;

notify pgrst, 'reload schema';
