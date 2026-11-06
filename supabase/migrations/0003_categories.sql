-- WALLET OS — Fase 2, Módulo 2: Categorias
--
-- Migration não destrutiva: nenhuma categoria é apagada e nenhuma transação muda.
-- Pode ser executada inteira de uma vez no SQL Editor (roda em uma transação).
-- Se houver referência a categoria de outro usuário, a FK composta aborta tudo.

-- ---------------------------------------------------------------------------
-- Tipo e arquivamento
-- ---------------------------------------------------------------------------
create type public.category_kind as enum ('income', 'expense');

alter table public.transaction_categories
  add column kind       public.category_kind not null default 'expense',
  add column archived   boolean not null default false,
  add column updated_at timestamptz not null default now();

create trigger set_updated_at before update on public.transaction_categories
  for each row execute function public.set_updated_at();

-- Categoria própria usada apenas em entradas é de receita.
update public.transaction_categories c
   set kind = 'income'
 where not c.is_system
   and exists (select 1 from public.transactions t where t.category_id = c.id)
   and not exists (
     select 1 from public.transactions t where t.category_id = c.id and t.amount_cents < 0
   );

-- ---------------------------------------------------------------------------
-- Categorias padrão. Só renomeia as que ainda têm o nome original: o que foi
-- personalizado fica como está. Mercado, Delivery, Jogos e Bobeiras continuam.
-- ---------------------------------------------------------------------------
update public.transaction_categories c
   set name = r.new_name
  from (values
    ('transporte',   'Uber e transporte', 'Transporte'),
    ('compras',      'Compras pessoais',  'Compras'),
    ('contas-fixas', 'Contas fixas',      'Contas'),
    ('outros',       'Outros',            'Outros gastos')
  ) as r (slug, old_name, new_name)
 where c.is_system and c.slug = r.slug and c.name = r.old_name;

insert into public.transaction_categories (user_id, name, slug, kind, is_system)
select p.id, s.name, s.slug, s.kind::public.category_kind, true
  from public.profiles p
 cross join (values
    ('Salário',             'salario',             'income'),
    ('Freelance',           'freelance',           'income'),
    ('Investimentos',       'investimentos',       'income'),
    ('Vendas',              'vendas',              'income'),
    ('Outros recebimentos', 'outros-recebimentos', 'income'),
    ('Moradia',             'moradia',             'expense')
  ) as s (name, slug, kind)
on conflict (user_id, slug) do nothing;

update public.transaction_categories c
   set icon = coalesce(c.icon, s.icon), color = coalesce(c.color, s.color)
  from (values
    ('salario',             'banknote',        '#4ade80'),
    ('freelance',           'laptop',          '#2dd4bf'),
    ('investimentos',       'trending-up',     '#60a5fa'),
    ('vendas',              'store',           '#a78bfa'),
    ('outros-recebimentos', 'circle-ellipsis', '#a3a3a3'),
    ('alimentacao',         'utensils',        '#fb923c'),
    ('moradia',             'house',           '#60a5fa'),
    ('transporte',          'car',             '#fbbf24'),
    ('saude',               'heart-pulse',     '#f87171'),
    ('educacao',            'graduation-cap',  '#2dd4bf'),
    ('lazer',               'party-popper',    '#f472b6'),
    ('compras',             'shopping-bag',    '#a78bfa'),
    ('assinaturas',         'repeat',          '#fafafa'),
    ('contas-fixas',        'receipt',         '#4ade80'),
    ('outros',              'circle-ellipsis', '#a3a3a3'),
    ('mercado',             'shopping-cart',   '#fb923c'),
    ('delivery',            'bike',            '#fbbf24'),
    ('jogos',               'gamepad-2',       '#a78bfa'),
    ('bobeiras',            'smile',           '#f472b6')
  ) as s (slug, icon, color)
 where c.is_system and c.slug = s.slug;

-- Novos usuários recebem a lista padrão.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1));

  insert into public.transaction_categories (user_id, name, slug, kind, icon, color, is_system) values
    (new.id, 'Salário',             'salario',             'income',  'banknote',        '#4ade80', true),
    (new.id, 'Freelance',           'freelance',           'income',  'laptop',          '#2dd4bf', true),
    (new.id, 'Investimentos',       'investimentos',       'income',  'trending-up',     '#60a5fa', true),
    (new.id, 'Vendas',              'vendas',              'income',  'store',           '#a78bfa', true),
    (new.id, 'Outros recebimentos', 'outros-recebimentos', 'income',  'circle-ellipsis', '#a3a3a3', true),
    (new.id, 'Alimentação',         'alimentacao',         'expense', 'utensils',        '#fb923c', true),
    (new.id, 'Moradia',             'moradia',             'expense', 'house',           '#60a5fa', true),
    (new.id, 'Transporte',          'transporte',          'expense', 'car',             '#fbbf24', true),
    (new.id, 'Saúde',               'saude',               'expense', 'heart-pulse',     '#f87171', true),
    (new.id, 'Educação',            'educacao',            'expense', 'graduation-cap',  '#2dd4bf', true),
    (new.id, 'Lazer',               'lazer',               'expense', 'party-popper',    '#f472b6', true),
    (new.id, 'Compras',             'compras',             'expense', 'shopping-bag',    '#a78bfa', true),
    (new.id, 'Assinaturas',         'assinaturas',         'expense', 'repeat',          '#fafafa', true),
    (new.id, 'Contas',              'contas-fixas',        'expense', 'receipt',         '#4ade80', true),
    (new.id, 'Outros gastos',       'outros',              'expense', 'circle-ellipsis', '#a3a3a3', true);

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Validações (cor e ícone não revalidam dados antigos: not valid)
-- ---------------------------------------------------------------------------
alter table public.transaction_categories
  add constraint transaction_categories_name_length
    check (char_length(btrim(name)) between 1 and 60),
  add constraint transaction_categories_color_format
    check (color is null or color ~ '^#[0-9a-f]{6}$') not valid,
  add constraint transaction_categories_icon_format
    check (icon is null or icon ~ '^[a-z0-9-]{1,40}$') not valid;

create index transaction_categories_user_kind_idx
  on public.transaction_categories (user_id, kind, name);

-- ---------------------------------------------------------------------------
-- Isolamento e integridade referencial (mesma regra de bank_accounts).
-- NO ACTION em transactions: categoria em uso não pode ser excluída.
-- ---------------------------------------------------------------------------
alter table public.transaction_categories
  add constraint transaction_categories_id_user_key unique (id, user_id);

alter table public.transactions drop constraint transactions_category_id_fkey;
alter table public.transactions
  add constraint transactions_category_user_fkey
    foreign key (category_id, user_id)
    references public.transaction_categories (id, user_id)
    on delete no action;

alter table public.category_rules drop constraint category_rules_category_id_fkey;
alter table public.category_rules
  add constraint category_rules_category_user_fkey
    foreign key (category_id, user_id)
    references public.transaction_categories (id, user_id)
    on delete cascade;

alter table public.financial_budgets drop constraint financial_budgets_category_id_fkey;
alter table public.financial_budgets
  add constraint financial_budgets_category_user_fkey
    foreign key (category_id, user_id)
    references public.transaction_categories (id, user_id)
    on delete cascade;

-- ---------------------------------------------------------------------------
-- Tipo travado depois do primeiro uso: mudá-lo tornaria transações incompatíveis.
-- ---------------------------------------------------------------------------
create function public.categories_lock_kind()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind <> old.kind
     and exists (select 1 from public.transactions t where t.category_id = old.id) then
    raise exception 'category kind is locked' using errcode = 'WL006';
  end if;
  return new;
end;
$$;

create trigger categories_lock_kind
  before update of kind on public.transaction_categories
  for each row execute function public.categories_lock_kind();

revoke all on function public.categories_lock_kind() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Totais por categoria. Roda com as permissões de quem chama: o RLS restringe
-- o resultado às transações do próprio usuário.
-- ---------------------------------------------------------------------------
create function public.category_totals(p_from date, p_to date)
returns table (
  category_id  uuid,
  period_cents bigint,
  period_count bigint,
  total_count  bigint
)
language sql
stable
set search_path = ''
as $$
  select t.category_id,
         coalesce(sum(t.amount_cents) filter (where t.posted_at between p_from and p_to), 0)::bigint,
         count(*) filter (where t.posted_at between p_from and p_to),
         count(*)
    from public.transactions t
   where t.category_id is not null
   group by t.category_id;
$$;

revoke all on function public.category_totals(date, date) from public, anon;
grant execute on function public.category_totals(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Privilégios: o cliente não forja is_system nem troca dono ou slug.
-- ---------------------------------------------------------------------------
revoke insert, update on public.transaction_categories from authenticated;

grant insert (user_id, name, slug, kind, color, icon)
  on public.transaction_categories to authenticated;

grant update (name, kind, color, icon, archived)
  on public.transaction_categories to authenticated;

notify pgrst, 'reload schema';
