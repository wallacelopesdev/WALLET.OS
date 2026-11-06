-- WALLET OS — Fase 2, Módulo 1: Contas bancárias
--
-- Migration não destrutiva: nenhum saldo existente muda de valor.
-- Pode ser executada inteira de uma vez no SQL Editor (roda em uma transação).
-- Se houver transação apontando para conta de outro usuário, a FK composta
-- aborta tudo sem alterar nada.
--
-- Invariante mantida pelo banco a partir daqui:
--   balance_cents = opening_balance_cents + soma(transactions.amount_cents)

-- ---------------------------------------------------------------------------
-- Tipos de conta. 'wallet' passa a significar "Carteira física".
-- Os novos valores não podem ser usados neste mesmo arquivo (regra do Postgres
-- para enums criados dentro de uma transação).
-- ---------------------------------------------------------------------------
alter type public.account_kind add value if not exists 'digital';
alter type public.account_kind add value if not exists 'cash';
alter type public.account_kind add value if not exists 'investment';
alter type public.account_kind add value if not exists 'other';

-- ---------------------------------------------------------------------------
-- Saldo inicial, com backfill que preserva o saldo atual de cada conta.
-- ---------------------------------------------------------------------------
alter table public.bank_accounts
  add column opening_balance_cents bigint not null default 0;

update public.bank_accounts a
   set opening_balance_cents = a.balance_cents - coalesce(
     (select sum(t.amount_cents) from public.transactions t where t.account_id = a.id),
     0
   );

-- ---------------------------------------------------------------------------
-- Instituição é opcional (carteira física, dinheiro em espécie).
-- ---------------------------------------------------------------------------
alter table public.bank_accounts alter column institution drop not null;

update public.bank_accounts set institution = null where btrim(institution) = '';

alter table public.bank_accounts
  add constraint bank_accounts_name_length
    check (char_length(btrim(name)) between 1 and 80),
  add constraint bank_accounts_institution_length
    check (institution is null or char_length(btrim(institution)) between 1 and 80),
  add constraint bank_accounts_opening_balance_range
    check (abs(opening_balance_cents) <= 100000000000000);

-- ---------------------------------------------------------------------------
-- Isolamento e integridade referencial.
-- O RLS só confere user_id: sem a FK composta, um usuário poderia gravar uma
-- transação apontando para a conta de outro (FKs ignoram RLS).
-- NO ACTION (e não RESTRICT): impede excluir conta com movimentações, mas é
-- verificado no fim do comando, então a cascata de exclusão do usuário funciona.
-- ---------------------------------------------------------------------------
alter table public.bank_accounts
  add constraint bank_accounts_id_user_key unique (id, user_id);

alter table public.transactions drop constraint transactions_account_id_fkey;

alter table public.transactions
  add constraint transactions_account_user_fkey
    foreign key (account_id, user_id)
    references public.bank_accounts (id, user_id)
    on delete no action;

create index transactions_user_account_date_idx
  on public.transactions (user_id, account_id, posted_at desc);

-- ---------------------------------------------------------------------------
-- Saldo controlado pelo banco.
-- ---------------------------------------------------------------------------
-- Escrita direta em balance_cents é ignorada, inclusive para roles privilegiadas.
-- Profundidade > 1 significa que o UPDATE veio de transactions_sync_balance.
create function public.bank_accounts_guard_balance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.balance_cents := new.opening_balance_cents;
  elsif pg_trigger_depth() <= 1 then
    new.balance_cents :=
      old.balance_cents + (new.opening_balance_cents - old.opening_balance_cents);
  end if;
  return new;
end;
$$;

create trigger bank_accounts_guard_balance
  before insert or update on public.bank_accounts
  for each row execute function public.bank_accounts_guard_balance();

-- security definer: o cliente não tem UPDATE em balance_cents. É seguro porque a
-- FK composta garante que account_id pertence ao dono da transação.
create function public.transactions_sync_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.account_id is not null then
    update public.bank_accounts
       set balance_cents = balance_cents - old.amount_cents
     where id = old.account_id;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.account_id is not null then
    update public.bank_accounts
       set balance_cents = balance_cents + new.amount_cents
     where id = new.account_id;
  end if;

  return null;
end;
$$;

create trigger transactions_sync_balance
  after insert or delete or update of account_id, amount_cents on public.transactions
  for each row execute function public.transactions_sync_balance();

revoke all on function public.bank_accounts_guard_balance() from public, anon, authenticated;
revoke all on function public.transactions_sync_balance() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Privilégios: defesa em profundidade além do RLS (políticas não mudam).
-- O cliente nunca escreve balance_cents, nem troca id ou user_id de uma conta.
-- ---------------------------------------------------------------------------
revoke insert, update on public.bank_accounts from authenticated;

grant insert (user_id, institution, name, kind, opening_balance_cents)
  on public.bank_accounts to authenticated;

grant update (institution, name, kind, opening_balance_cents, archived)
  on public.bank_accounts to authenticated;
