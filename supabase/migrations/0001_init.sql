-- WALLET OS — migration inicial (Fase 1)
-- Valores monetários em centavos (bigint). Negativo = saída, positivo = entrada.
-- Todas as tabelas têm RLS: cada linha só é acessível pelo dono (user_id = auth.uid()).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
create type public.account_kind    as enum ('checking', 'savings', 'wallet');
create type public.record_source   as enum ('manual', 'import');
create type public.tx_kind         as enum ('pix_in', 'pix_out', 'debit', 'credit', 'transfer', 'invoice_payment', 'refund', 'income', 'other');
create type public.category_source as enum ('rule', 'ai', 'manual');
create type public.invoice_status  as enum ('open', 'closed', 'paid');
create type public.task_status     as enum ('pending', 'in_progress', 'done', 'overdue');
create type public.task_priority   as enum ('low', 'medium', 'high', 'urgent');
create type public.draft_status    as enum ('draft', 'pending_approval', 'approved', 'sent', 'discarded');
create type public.action_status   as enum ('proposed', 'awaiting_confirmation', 'confirmed', 'executed', 'failed', 'rejected');

-- ---------------------------------------------------------------------------
-- Funções utilitárias
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users (perfil) — extensão de auth.users
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  locale       text not null default 'pt-BR',
  timezone     text not null default 'America/Sao_Paulo',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Finanças
-- ---------------------------------------------------------------------------
create table public.bank_accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  institution   text not null,
  name          text not null,
  kind          public.account_kind not null default 'checking',
  source        public.record_source not null default 'manual',
  balance_cents bigint not null default 0,
  currency      char(3) not null default 'BRL',
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index bank_accounts_user_idx on public.bank_accounts (user_id) where not archived;

-- Substitui "bank_connections": sem Open Finance, cada importação de extrato é um lote.
create table public.import_batches (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  account_id      uuid references public.bank_accounts (id) on delete set null,
  source_name     text not null,
  file_name       text,
  format          text not null check (format in ('ofx', 'csv', 'manual')),
  status          text not null default 'completed' check (status in ('processing', 'completed', 'failed')),
  rows_total      integer not null default 0,
  rows_inserted   integer not null default 0,
  rows_duplicated integer not null default 0,
  error           text,
  created_at      timestamptz not null default now()
);
create index import_batches_user_idx on public.import_batches (user_id, created_at desc);

create table public.transaction_categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  name       text not null,
  slug       text not null,
  color      text,
  icon       text,
  is_system  boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, slug)
);

-- Regras determinísticas de categorização (aplicadas antes da IA).
create table public.category_rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  category_id uuid not null references public.transaction_categories (id) on delete cascade,
  pattern     text not null,
  match_type  text not null default 'contains' check (match_type in ('contains', 'starts_with', 'regex')),
  priority    integer not null default 100,
  created_at  timestamptz not null default now()
);
create index category_rules_user_idx on public.category_rules (user_id, priority);

create table public.credit_cards (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  institution text not null,
  name        text not null,
  -- Somente os 4 últimos dígitos. Nunca armazenar número completo, CVV ou senha.
  last4       char(4) check (last4 ~ '^[0-9]{4}$'),
  limit_cents bigint not null default 0 check (limit_cents >= 0),
  closing_day smallint not null check (closing_day between 1 and 31),
  due_day     smallint not null check (due_day between 1 and 31),
  source      public.record_source not null default 'manual',
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index credit_cards_user_idx on public.credit_cards (user_id) where not archived;

create table public.transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  account_id      uuid references public.bank_accounts (id) on delete set null,
  card_id         uuid references public.credit_cards (id) on delete set null,
  category_id     uuid references public.transaction_categories (id) on delete set null,
  batch_id        uuid references public.import_batches (id) on delete set null,
  posted_at       date not null,
  description     text not null,
  amount_cents    bigint not null,
  kind            public.tx_kind not null default 'other',
  category_source public.category_source,
  external_id     text,
  -- Prevenção de duplicidade: hash de (conta/cartão, data, valor, descrição normalizada, ocorrência).
  dedupe_hash     text not null,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (account_id is not null or card_id is not null),
  unique (user_id, dedupe_hash)
);
create unique index transactions_external_uidx
  on public.transactions (user_id, account_id, external_id) where external_id is not null;
create index transactions_user_date_idx on public.transactions (user_id, posted_at desc);
create index transactions_user_category_idx on public.transactions (user_id, category_id);
create index transactions_card_idx on public.transactions (card_id, posted_at desc) where card_id is not null;

create table public.card_invoices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  card_id         uuid not null references public.credit_cards (id) on delete cascade,
  reference_month date not null check (extract(day from reference_month) = 1),
  closing_date    date not null,
  due_date        date not null,
  total_cents     bigint not null default 0 check (total_cents >= 0),
  status          public.invoice_status not null default 'open',
  paid_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (card_id, reference_month)
);
create index card_invoices_user_due_idx on public.card_invoices (user_id, due_date) where status <> 'paid';

create table public.card_installments (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.profiles (id) on delete cascade,
  card_id                  uuid not null references public.credit_cards (id) on delete cascade,
  transaction_id           uuid references public.transactions (id) on delete set null,
  description              text not null,
  total_cents              bigint not null check (total_cents > 0),
  installment_cents        bigint not null check (installment_cents > 0),
  installments_total       smallint not null check (installments_total > 1),
  installments_paid        smallint not null default 0,
  first_invoice_month      date not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (installments_paid between 0 and installments_total)
);
create index card_installments_card_idx on public.card_installments (card_id);

create table public.financial_budgets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  category_id uuid not null references public.transaction_categories (id) on delete cascade,
  month       date not null check (extract(day from month) = 1),
  limit_cents bigint not null check (limit_cents >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, category_id, month)
);

create table public.financial_goals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  name          text not null,
  target_cents  bigint not null check (target_cents > 0),
  current_cents bigint not null default 0 check (current_cents >= 0),
  deadline      date,
  status        text not null default 'active' check (status in ('active', 'achieved', 'cancelled')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Chief of Staff
-- ---------------------------------------------------------------------------
-- Tokens OAuth ficam criptografados (AES-256-GCM no backend) e NÃO são legíveis
-- pelo cliente: ver GRANTs por coluna mais abaixo.
create table public.email_accounts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  provider          text not null default 'google',
  email             text not null,
  scopes            text[] not null default '{}',
  access_token_enc  text,
  refresh_token_enc text,
  token_expires_at  timestamptz,
  status            text not null default 'active' check (status in ('active', 'revoked', 'error')),
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, provider, email)
);

create table public.email_summaries (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  email_account_id uuid not null references public.email_accounts (id) on delete cascade,
  gmail_message_id text not null,
  gmail_thread_id  text,
  sender           text not null,
  subject          text,
  summary          text,
  priority         public.task_priority not null default 'medium',
  category         text check (category in ('cobranca', 'convite', 'prazo', 'profissional', 'outros')),
  deadline_at      timestamptz,
  needs_reply      boolean not null default false,
  received_at      timestamptz not null,
  created_at       timestamptz not null default now(),
  unique (email_account_id, gmail_message_id)
);
create index email_summaries_user_idx on public.email_summaries (user_id, received_at desc);
create index email_summaries_reply_idx on public.email_summaries (user_id) where needs_reply;

create table public.email_drafts (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles (id) on delete cascade,
  email_account_id       uuid not null references public.email_accounts (id) on delete cascade,
  in_reply_to_summary_id uuid references public.email_summaries (id) on delete set null,
  to_addresses           text[] not null default '{}',
  subject                text,
  body                   text not null default '',
  status                 public.draft_status not null default 'draft',
  gmail_draft_id         text,
  approved_at            timestamptz,
  sent_at                timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- O envio exige aprovação explícita do usuário.
  check (status <> 'sent' or approved_at is not null)
);
create index email_drafts_user_idx on public.email_drafts (user_id, status);

create table public.calendar_events (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  email_account_id uuid references public.email_accounts (id) on delete cascade,
  google_event_id  text,
  title            text not null,
  description      text,
  location         text,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  all_day          boolean not null default false,
  status           text not null default 'confirmed' check (status in ('confirmed', 'tentative', 'cancelled')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_at >= starts_at),
  unique (email_account_id, google_event_id)
);
create index calendar_events_user_idx on public.calendar_events (user_id, starts_at);

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  name        text not null,
  description text,
  status      text not null default 'active' check (status in ('active', 'paused', 'done')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.tasks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  project_id   uuid references public.projects (id) on delete set null,
  title        text not null,
  description  text,
  priority     public.task_priority not null default 'medium',
  status       public.task_status not null default 'pending',
  category     text,
  due_at       timestamptz,
  completed_at timestamptz,
  source       text not null default 'manual' check (source in ('manual', 'chat')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index tasks_user_status_idx on public.tasks (user_id, status, due_at);

-- ---------------------------------------------------------------------------
-- AI Command Center
-- ---------------------------------------------------------------------------
create table public.ai_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ai_messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant', 'tool')),
  content         text not null,
  tool_name       text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index ai_messages_conv_idx on public.ai_messages (conversation_id, created_at);

create table public.agent_actions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles (id) on delete cascade,
  conversation_id       uuid references public.ai_conversations (id) on delete set null,
  tool_name             text not null,
  input                 jsonb not null default '{}'::jsonb,
  output                jsonb,
  status                public.action_status not null default 'proposed',
  requires_confirmation boolean not null default true,
  -- 'untrusted_content' = ação sugerida a partir de e-mail/documento: sempre exige confirmação humana.
  origin                text not null default 'user' check (origin in ('user', 'untrusted_content')),
  confirmed_at          timestamptz,
  executed_at           timestamptz,
  error                 text,
  created_at            timestamptz not null default now(),
  check (origin = 'user' or requires_confirmation)
);
create index agent_actions_user_idx on public.agent_actions (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Auditoria e notificações
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles (id) on delete set null,
  event       text not null,
  entity_type text,
  entity_id   text,
  ip          inet,
  user_agent  text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_user_idx on public.audit_logs (user_id, created_at desc);

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text not null,
  body       text,
  kind       text not null default 'info',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc) where read_at is null;

-- ---------------------------------------------------------------------------
-- Triggers de updated_at
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'bank_accounts', 'credit_cards', 'transactions', 'card_invoices',
    'card_installments', 'financial_budgets', 'financial_goals', 'email_accounts',
    'email_drafts', 'calendar_events', 'projects', 'tasks', 'ai_conversations'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
create policy profiles_select_own on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array[
    'bank_accounts', 'import_batches', 'transaction_categories', 'category_rules',
    'credit_cards', 'transactions', 'card_invoices', 'card_installments',
    'financial_budgets', 'financial_goals', 'email_accounts', 'email_summaries',
    'email_drafts', 'calendar_events', 'projects', 'tasks', 'ai_conversations',
    'ai_messages', 'agent_actions', 'notifications'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_owner', t);
  end loop;
end $$;

-- Auditoria: o usuário lê e insere seus próprios registros; ninguém altera ou apaga.
alter table public.audit_logs enable row level security;
create policy audit_logs_select_own on public.audit_logs for select to authenticated using (user_id = auth.uid());
create policy audit_logs_insert_own on public.audit_logs for insert to authenticated with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Privilégios: defesa em profundidade além do RLS
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;

-- Tokens OAuth: o cliente nunca lê as colunas criptografadas; só o backend (service role).
revoke all on public.email_accounts from authenticated;
grant select (id, user_id, provider, email, scopes, status, token_expires_at, revoked_at, created_at, updated_at)
  on public.email_accounts to authenticated;
grant delete on public.email_accounts to authenticated;

-- audit_logs é append-only para o cliente.
revoke update, delete on public.audit_logs from authenticated;

-- ---------------------------------------------------------------------------
-- Novo usuário: cria perfil e as categorias padrão
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1));

  insert into public.transaction_categories (user_id, name, slug, is_system) values
    (new.id, 'Uber e transporte', 'transporte',     true),
    (new.id, 'Mercado',           'mercado',        true),
    (new.id, 'Alimentação',       'alimentacao',    true),
    (new.id, 'Delivery',          'delivery',       true),
    (new.id, 'Lazer',             'lazer',          true),
    (new.id, 'Jogos',             'jogos',          true),
    (new.id, 'Compras pessoais',  'compras',        true),
    (new.id, 'Assinaturas',       'assinaturas',    true),
    (new.id, 'Contas fixas',      'contas-fixas',   true),
    (new.id, 'Saúde',             'saude',          true),
    (new.id, 'Educação',          'educacao',       true),
    (new.id, 'Bobeiras',          'bobeiras',       true),
    (new.id, 'Outros',            'outros',         true);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
