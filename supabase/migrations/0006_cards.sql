-- WALLET OS — Fase 2, Módulos 4 e 5: Cartões, faturas e parcelamentos.
--
-- Migration não destrutiva. Pode ser executada inteira de uma vez no SQL Editor.
-- Regra de competência: a compra feita ANTES do dia de fechamento entra na fatura
-- que fecha naquele mês; a feita NO dia de fechamento ou depois entra na seguinte.
-- reference_month é o mês em que a fatura fecha. Dias que não existem no mês
-- (31 em fevereiro) viram o último dia do mês.
-- Compras no cartão têm account_id nulo e não mexem no saldo. O pagamento da fatura
-- mexe no saldo, mas é invoice_payment: não conta como despesa, sem duplicidade.

-- ---------------------------------------------------------------------------
-- Cartões
-- ---------------------------------------------------------------------------
alter table public.credit_cards
  add constraint credit_cards_name_length
    check (char_length(btrim(name)) between 1 and 80),
  add constraint credit_cards_institution_length
    check (char_length(btrim(institution)) between 1 and 80),
  add constraint credit_cards_limit_range
    check (limit_cents <= 100000000000000),
  add constraint credit_cards_id_user_key unique (id, user_id);

-- ---------------------------------------------------------------------------
-- Faturas: total e valor pago são mantidos por trigger, de forma incremental, para
-- não zerar faturas antigas digitadas à mão sem compras associadas.
-- ---------------------------------------------------------------------------
alter table public.card_invoices
  add column paid_cents bigint not null default 0 check (paid_cents >= 0);

update public.card_invoices set paid_cents = total_cents where status = 'paid';

alter table public.card_invoices
  add constraint card_invoices_id_user_key unique (id, user_id);

alter table public.card_invoices drop constraint card_invoices_card_id_fkey;
alter table public.card_invoices
  add constraint card_invoices_card_user_fkey
    foreign key (card_id, user_id) references public.credit_cards (id, user_id)
    on delete cascade;

-- ---------------------------------------------------------------------------
-- Planos de parcelamento e vínculos dos lançamentos
-- ---------------------------------------------------------------------------
alter table public.card_installments
  add constraint card_installments_id_user_key unique (id, user_id);

alter table public.card_installments drop constraint card_installments_card_id_fkey;
alter table public.card_installments
  add constraint card_installments_card_user_fkey
    foreign key (card_id, user_id) references public.credit_cards (id, user_id)
    on delete cascade;

alter table public.transactions
  add column invoice_id         uuid,
  add column installment_id     uuid,
  add column installment_number smallint,
  add column installment_total  smallint;

alter table public.transactions drop constraint transactions_card_id_fkey;
alter table public.transactions
  add constraint transactions_card_user_fkey
    foreign key (card_id, user_id) references public.credit_cards (id, user_id)
    on delete no action,
  add constraint transactions_invoice_user_fkey
    foreign key (invoice_id, user_id) references public.card_invoices (id, user_id)
    on delete no action,
  add constraint transactions_installment_user_fkey
    foreign key (installment_id, user_id) references public.card_installments (id, user_id)
    on delete no action;

create index transactions_invoice_idx
  on public.transactions (invoice_id, posted_at desc) where invoice_id is not null;
create index transactions_installment_idx
  on public.transactions (installment_id) where installment_id is not null;

-- ---------------------------------------------------------------------------
-- Datas de competência
-- ---------------------------------------------------------------------------
create function public.clamped_date(p_month date, p_day integer)
returns date
language sql
immutable
set search_path = ''
as $$
  select make_date(
    extract(year from p_month)::integer,
    extract(month from p_month)::integer,
    least(
      p_day,
      extract(day from (date_trunc('month', p_month) + interval '1 month - 1 day'))::integer
    )
  );
$$;

create function public.card_invoice_month(p_date date, p_closing_day integer)
returns date
language sql
immutable
set search_path = ''
as $$
  select case
    when p_date >= public.clamped_date(p_date, p_closing_day)
      then (date_trunc('month', p_date) + interval '1 month')::date
    else date_trunc('month', p_date)::date
  end;
$$;

-- ---------------------------------------------------------------------------
-- Regras de cada lançamento: acrescenta as de cartão às do módulo de transações.
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
       and (new.kind::text <> 'expense' or new.invoice_id is null) then
      raise exception 'card purchase needs an invoice' using errcode = 'WL010';
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
-- Total e valor pago da fatura acompanham os lançamentos.
-- ---------------------------------------------------------------------------
create function public.transactions_sync_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_sign integer;
begin
  for v_row in
    select old.invoice_id as invoice_id, old.amount_cents as amount_cents,
           old.kind::text as kind, -1 as direction
     where tg_op <> 'INSERT' and old.invoice_id is not null
    union all
    select new.invoice_id, new.amount_cents, new.kind::text, 1
     where tg_op <> 'DELETE' and new.invoice_id is not null
  loop
    v_sign := v_row.direction;
    if v_row.kind = 'invoice_payment' then
      update public.card_invoices
         set paid_cents = paid_cents + v_sign * (-v_row.amount_cents)
       where id = v_row.invoice_id;
    else
      update public.card_invoices
         set total_cents = total_cents + v_sign * (-v_row.amount_cents)
       where id = v_row.invoice_id;
    end if;

    update public.card_invoices i
       set status = case
             when i.total_cents > 0 and i.paid_cents >= i.total_cents
               then 'paid'::public.invoice_status
             else 'open'::public.invoice_status
           end,
           paid_at = case
             when i.total_cents > 0 and i.paid_cents >= i.total_cents
               then coalesce(i.paid_at, now())
             else null
           end
     where i.id = v_row.invoice_id;
  end loop;

  return null;
end;
$$;

create trigger transactions_sync_invoice
  after insert or delete or update of amount_cents, invoice_id, kind on public.transactions
  for each row execute function public.transactions_sync_invoice();

-- ---------------------------------------------------------------------------
-- Parcelamento íntegro no fim da transação, por qualquer caminho de escrita.
-- ---------------------------------------------------------------------------
create function public.transactions_installment_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_plan_total bigint;
  v_plan_count integer;
  v_rows integer;
  v_sum numeric;
begin
  foreach v_id in array array[
    case when tg_op <> 'INSERT' then old.installment_id end,
    case when tg_op <> 'DELETE' then new.installment_id end
  ] loop
    continue when v_id is null;

    select p.total_cents, p.installments_total into v_plan_total, v_plan_count
      from public.card_installments p where p.id = v_id;
    continue when not found;

    select count(*), coalesce(sum(-t.amount_cents), 0) into v_rows, v_sum
      from public.transactions t where t.installment_id = v_id;

    if v_rows <> v_plan_count or v_sum <> v_plan_total then
      raise exception 'invalid installment plan' using errcode = 'WL011';
    end if;
  end loop;
  return null;
end;
$$;

create constraint trigger transactions_installment_integrity
  after insert or update or delete on public.transactions
  deferrable initially deferred
  for each row execute function public.transactions_installment_integrity();

-- ---------------------------------------------------------------------------
-- Internas: só outras funções do banco as chamam.
-- ---------------------------------------------------------------------------
create function public._ensure_card_invoice(p_user uuid, p_card uuid, p_reference date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_closing_day integer;
  v_due_day integer;
  v_closing date;
  v_due date;
begin
  select c.closing_day, c.due_day into v_closing_day, v_due_day
    from public.credit_cards c where c.id = p_card and c.user_id = p_user;
  if not found then
    raise exception 'card not found' using errcode = 'P0002';
  end if;

  v_closing := public.clamped_date(p_reference, v_closing_day);
  -- Vencimento depois do fechamento: mesmo mês. Antes ou no mesmo dia: mês seguinte.
  v_due := public.clamped_date(
    case when v_due_day > v_closing_day then p_reference
         else (p_reference + interval '1 month')::date end,
    v_due_day
  );

  insert into public.card_invoices (user_id, card_id, reference_month, closing_date, due_date)
  values (p_user, p_card, p_reference, v_closing, v_due)
  on conflict (card_id, reference_month) do nothing;

  select i.id into v_id
    from public.card_invoices i
   where i.card_id = p_card and i.reference_month = p_reference;
  return v_id;
end;
$$;

-- A soma das parcelas é sempre igual ao total: os centavos que sobram da divisão
-- inteira vão na primeira parcela. Devolve o id do primeiro lançamento.
create function public._insert_card_purchase(
  p_user uuid, p_card uuid, p_description text, p_total_cents bigint,
  p_installments integer, p_date date, p_category uuid, p_notes text, p_dedupe text
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
       p_category, case when p_category is not null then 'manual'::public.category_source end,
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

-- ---------------------------------------------------------------------------
-- Operações do cliente. security definer porque o cliente não escreve em faturas;
-- cada uma confere o dono explicitamente com auth.uid().
-- ---------------------------------------------------------------------------
create function public.create_card_purchase(
  p_card uuid, p_description text, p_amount_cents bigint, p_installments integer,
  p_posted_at date, p_category uuid, p_notes text, p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_existing uuid;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select t.id into v_existing from public.transactions t
   where t.user_id = v_user and t.dedupe_hash = 'purchase:' || p_request_id::text || ':1';
  if v_existing is not null then
    return v_existing;
  end if;

  v_id := public._insert_card_purchase(
    v_user, p_card, p_description, p_amount_cents, p_installments,
    p_posted_at, p_category, p_notes, 'purchase:' || p_request_id::text
  );
  set constraints all immediate;
  return v_id;
end;
$$;

-- Exclui a compra inteira. Recusa se alguma fatura envolvida já recebeu pagamento,
-- pois o valor pago ficaria maior que o total.
create function public.delete_card_purchase(p_transaction uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_installment uuid;
  v_invoices uuid[];
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select t.installment_id into v_installment
    from public.transactions t
   where t.id = p_transaction and t.user_id = v_user
     and t.card_id is not null and t.account_id is null;
  if not found then
    raise exception 'purchase not found' using errcode = 'P0002';
  end if;

  select array_agg(t.invoice_id) into v_invoices
    from public.transactions t
   where t.user_id = v_user
     and (t.id = p_transaction or (v_installment is not null and t.installment_id = v_installment));

  if exists (
    select 1 from public.card_invoices i where i.id = any(v_invoices) and i.paid_cents > 0
  ) then
    raise exception 'invoice already has payments' using errcode = 'WL008';
  end if;

  delete from public.transactions t
   where t.user_id = v_user
     and (t.id = p_transaction or (v_installment is not null and t.installment_id = v_installment));

  if v_installment is not null then
    delete from public.card_installments p where p.id = v_installment and p.user_id = v_user;
  end if;

  delete from public.card_invoices i
   where i.id = any(v_invoices) and i.total_cents = 0 and i.paid_cents = 0;

  set constraints all immediate;
end;
$$;

-- Aceita pagamento parcial. Trava a fatura para que dois pagamentos simultâneos não
-- ultrapassem o total. p_request_id impede pagar duas vezes pelo mesmo envio.
create function public.pay_invoice(
  p_invoice uuid, p_account uuid, p_amount_cents bigint, p_paid_at date, p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_invoice record;
  v_existing uuid;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select t.id into v_existing from public.transactions t
   where t.user_id = v_user and t.dedupe_hash = 'payment:' || p_request_id::text;
  if v_existing is not null then
    return v_existing;
  end if;

  select i.id, i.card_id, i.total_cents, i.paid_cents, c.name as card_name into v_invoice
    from public.card_invoices i
    join public.credit_cards c on c.id = i.card_id
   where i.id = p_invoice and i.user_id = v_user
     for update of i;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'amount must be positive' using errcode = 'WL004';
  end if;
  if p_amount_cents > v_invoice.total_cents - v_invoice.paid_cents then
    raise exception 'payment above invoice balance' using errcode = 'WL007';
  end if;

  insert into public.transactions
    (user_id, account_id, card_id, invoice_id, posted_at, description, amount_cents,
     kind, dedupe_hash)
  values
    (v_user, p_account, v_invoice.card_id, p_invoice, p_paid_at,
     'Pagamento de fatura ' || v_invoice.card_name, -p_amount_cents,
     'invoice_payment', 'payment:' || p_request_id::text)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
revoke all on function public.transactions_sync_invoice() from public, anon, authenticated;
revoke all on function public.transactions_installment_integrity() from public, anon, authenticated;
revoke all on function public._ensure_card_invoice(uuid, uuid, date) from public, anon, authenticated;
revoke all on function public._insert_card_purchase(uuid, uuid, text, bigint, integer, date, uuid, text, text) from public, anon, authenticated;

revoke all on function public.create_card_purchase(uuid, text, bigint, integer, date, uuid, text, uuid) from public, anon;
revoke all on function public.delete_card_purchase(uuid) from public, anon;
revoke all on function public.pay_invoice(uuid, uuid, bigint, date, uuid) from public, anon;
grant execute on function public.create_card_purchase(uuid, text, bigint, integer, date, uuid, text, uuid) to authenticated;
grant execute on function public.delete_card_purchase(uuid) to authenticated;
grant execute on function public.pay_invoice(uuid, uuid, bigint, date, uuid) to authenticated;

-- O cliente nunca escreve em faturas e planos: só pelas funções acima.
revoke insert, update, delete on public.card_invoices from authenticated;
revoke insert, update, delete on public.card_installments from authenticated;

-- Cartão: nunca source, nem troca de dono. last4 continua validado pela constraint.
revoke insert, update on public.credit_cards from authenticated;
grant insert (user_id, institution, name, last4, limit_cents, closing_day, due_day)
  on public.credit_cards to authenticated;
grant update (institution, name, last4, limit_cents, closing_day, due_day, archived)
  on public.credit_cards to authenticated;

notify pgrst, 'reload schema';
