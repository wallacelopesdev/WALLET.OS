-- WALLET OS — Fase 2, Módulo 3 (parte 2 de 2): Transações e transferências.
--
-- Migration não destrutiva: nenhum valor, data ou saldo muda. Os tipos antigos que
-- misturavam tipo e método (pix_in, debit...) são separados em tipo + método.
-- Requer a 0004 já aplicada. Pode ser executada inteira de uma vez no SQL Editor.

-- ---------------------------------------------------------------------------
-- Novas colunas
-- ---------------------------------------------------------------------------
create type public.payment_method as enum ('pix', 'cash', 'debit', 'credit', 'boleto', 'transfer', 'other');

alter table public.transactions
  add column payment_method    public.payment_method,
  add column competence_date   date,
  add column transfer_group_id uuid,
  -- Permite ordenar por valor sem misturar entradas e saídas.
  add column amount_abs_cents  bigint generated always as (abs(amount_cents)) stored;

-- ---------------------------------------------------------------------------
-- Separa tipo e método nos dados existentes. refund, transfer e invoice_payment
-- continuam como estão; o sinal do valor define receita ou despesa.
-- ---------------------------------------------------------------------------
update public.transactions
   set payment_method = (case kind::text
         when 'pix_in'  then 'pix'
         when 'pix_out' then 'pix'
         when 'debit'   then 'debit'
         when 'credit'  then 'credit'
       end)::public.payment_method,
       kind = (case
         when kind::text in ('pix_in', 'pix_out', 'debit', 'credit', 'income', 'other')
              and amount_cents > 0 then 'income'
         when kind::text in ('pix_in', 'pix_out', 'debit', 'credit', 'income', 'other')
              and amount_cents < 0 then 'expense'
         else kind::text
       end)::public.tx_kind
 where kind::text in ('pix_in', 'pix_out', 'debit', 'credit', 'income', 'other');

-- ---------------------------------------------------------------------------
-- Limites (not valid: valem para o que for gravado daqui em diante)
-- ---------------------------------------------------------------------------
alter table public.transactions
  add constraint transactions_description_length
    check (char_length(btrim(description)) between 1 and 200) not valid,
  add constraint transactions_notes_length
    check (notes is null or char_length(notes) <= 1000) not valid,
  add constraint transactions_amount_range
    check (abs(amount_cents) <= 100000000000000) not valid;

create index transactions_transfer_group_idx
  on public.transactions (transfer_group_id) where transfer_group_id is not null;
create index transactions_user_amount_idx
  on public.transactions (user_id, amount_abs_cents desc);

-- ---------------------------------------------------------------------------
-- Regras de cada lançamento. Roda com as permissões de quem grava, então conta
-- ou categoria de outro usuário não é encontrada aqui e cai na FK composta.
-- Só revalida o que mudou: lançamentos antigos continuam editáveis.
-- ---------------------------------------------------------------------------
create function public.transactions_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_is_new boolean := tg_op = 'INSERT';
  v_category_kind text;
  v_category_archived boolean;
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

  return new;
end;
$$;

create trigger transactions_validate
  before insert or update on public.transactions
  for each row execute function public.transactions_validate();

-- ---------------------------------------------------------------------------
-- Integridade da transferência, verificada no fim da transação: exatamente dois
-- lançamentos do mesmo usuário e na mesma data, em contas diferentes, somando zero.
-- Vale para qualquer caminho de escrita, então nenhuma "perna" solta vira receita
-- ou despesa artificial. security definer para enxergar o grupo inteiro.
-- ---------------------------------------------------------------------------
create function public.transactions_check_transfer_group(p_group uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
  v_sum numeric;
  v_accounts integer;
  v_dates integer;
  v_users integer;
  v_all_transfers boolean;
begin
  select count(*), coalesce(sum(t.amount_cents), 0), count(distinct t.account_id),
         count(distinct t.posted_at), count(distinct t.user_id),
         coalesce(bool_and(t.kind::text = 'transfer'), true)
    into v_rows, v_sum, v_accounts, v_dates, v_users, v_all_transfers
    from public.transactions t
   where t.transfer_group_id = p_group;

  -- Grupo vazio: os dois lados foram excluídos juntos.
  if v_rows = 0 then
    return;
  end if;

  if v_rows <> 2 or v_sum <> 0 or v_accounts <> 2 or v_dates <> 1 or v_users <> 1
     or not v_all_transfers then
    raise exception 'invalid transfer group' using errcode = 'WL005';
  end if;
end;
$$;

create function public.transactions_transfer_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' and old.transfer_group_id is not null then
    perform public.transactions_check_transfer_group(old.transfer_group_id);
  end if;
  if tg_op <> 'DELETE' and new.transfer_group_id is not null then
    perform public.transactions_check_transfer_group(new.transfer_group_id);
  end if;
  return null;
end;
$$;

create constraint trigger transactions_transfer_integrity
  after insert or update or delete on public.transactions
  deferrable initially deferred
  for each row execute function public.transactions_transfer_integrity();

revoke all on function public.transactions_validate() from public, anon, authenticated;
revoke all on function public.transactions_check_transfer_group(uuid) from public, anon, authenticated;
revoke all on function public.transactions_transfer_integrity() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Transferências: os dois lados na mesma transação, com as permissões de quem
-- chama (RLS e triggers valem normalmente). p_request_id torna o envio idempotente.
-- ---------------------------------------------------------------------------
create function public.create_transfer(
  p_from_account uuid,
  p_to_account   uuid,
  p_amount_cents bigint,
  p_posted_at    date,
  p_description  text,
  p_notes        text,
  p_request_id   uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_group uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'amount must be positive' using errcode = 'WL004';
  end if;
  if p_from_account = p_to_account then
    raise exception 'accounts must differ' using errcode = 'WL005';
  end if;

  select t.transfer_group_id into v_group
    from public.transactions t
   where t.user_id = v_user
     and t.dedupe_hash = 'transfer:' || p_request_id::text || ':out';
  if v_group is not null then
    return v_group;
  end if;

  v_group := gen_random_uuid();

  insert into public.transactions
    (user_id, account_id, posted_at, description, amount_cents, kind,
     payment_method, notes, transfer_group_id, dedupe_hash)
  values
    (v_user, p_from_account, p_posted_at, p_description, -p_amount_cents, 'transfer',
     'transfer', p_notes, v_group, 'transfer:' || p_request_id::text || ':out'),
    (v_user, p_to_account, p_posted_at, p_description, p_amount_cents, 'transfer',
     'transfer', p_notes, v_group, 'transfer:' || p_request_id::text || ':in');

  set constraints all immediate;
  return v_group;
end;
$$;

create function public.update_transfer(
  p_group        uuid,
  p_from_account uuid,
  p_to_account   uuid,
  p_amount_cents bigint,
  p_posted_at    date,
  p_description  text,
  p_notes        text
)
returns uuid
language plpgsql
set search_path = ''
as $$
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'amount must be positive' using errcode = 'WL004';
  end if;
  if p_from_account = p_to_account then
    raise exception 'accounts must differ' using errcode = 'WL005';
  end if;

  update public.transactions t
     set account_id = p_from_account, amount_cents = -p_amount_cents,
         posted_at = p_posted_at, description = p_description, notes = p_notes
   where t.transfer_group_id = p_group and t.amount_cents < 0;

  if not found then
    raise exception 'transfer not found' using errcode = 'P0002';
  end if;

  update public.transactions t
     set account_id = p_to_account, amount_cents = p_amount_cents,
         posted_at = p_posted_at, description = p_description, notes = p_notes
   where t.transfer_group_id = p_group and t.amount_cents > 0;

  set constraints all immediate;
  return p_group;
end;
$$;

revoke all on function public.create_transfer(uuid, uuid, bigint, date, text, text, uuid) from public, anon;
revoke all on function public.update_transfer(uuid, uuid, uuid, bigint, date, text, text) from public, anon;
grant execute on function public.create_transfer(uuid, uuid, bigint, date, text, text, uuid) to authenticated;
grant execute on function public.update_transfer(uuid, uuid, uuid, bigint, date, text, text) to authenticated;

notify pgrst, 'reload schema';
