-- WALLET OS — Financial Agent: boletos.
--
-- Migration não destrutiva. A Pluggy não informa boletos pendentes (não suporta DDA), então
-- eles são cadastrados por você. "Pago" não é um campo que se edita: só existe quando há
-- uma transação de boleto confirmada ligada ao registro. Excluir a transação reabre o boleto.

create table public.bills (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  beneficiary         text not null check (char_length(btrim(beneficiary)) between 1 and 120),
  amount_cents        bigint not null check (amount_cents > 0 and amount_cents <= 100000000000000),
  due_date            date not null,
  notes               text check (notes is null or char_length(notes) <= 500),
  dismissed           boolean not null default false,
  paid_transaction_id uuid references public.transactions (id) on delete set null,
  paid_amount_cents   bigint,
  paid_at             date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index bills_user_due_idx on public.bills (user_id, due_date) where paid_transaction_id is null and not dismissed;

create trigger set_updated_at before update on public.bills
  for each row execute function public.set_updated_at();

alter table public.bills enable row level security;
create policy bills_owner on public.bills for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.bills from anon;
revoke insert, update on public.bills from authenticated;
grant insert (user_id, beneficiary, amount_cents, due_date, notes) on public.bills to authenticated;
grant update (beneficiary, amount_cents, due_date, notes, dismissed) on public.bills to authenticated;

-- Liga o pagamento confirmado ao boleto em aberto, só com correspondência única. Valor pago
-- igual, ou até 20% acima (multa e juros) quando o beneficiário também é parecido.
create function public.transactions_match_bill()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_paid bigint := -new.amount_cents;
begin
  if new.amount_cents >= 0 or new.account_id is null
     or new.kind::text <> 'expense' or new.payment_method is distinct from 'boleto' then
    return null;
  end if;

  select array_agg(b.id) into v_ids
    from public.bills b
   where b.user_id = new.user_id
     and b.paid_transaction_id is null
     and not b.dismissed
     and new.posted_at between b.due_date - 45 and b.due_date + 45
     and (
       (b.amount_cents = v_paid and new.posted_at between b.due_date - 15 and b.due_date + 15)
       or (v_paid > b.amount_cents and v_paid <= b.amount_cents * 1.2
           and public.agent_similarity(b.beneficiary, new.description) >= 0.5)
     );

  if cardinality(v_ids) = 1 then
    update public.bills
       set paid_transaction_id = new.id, paid_amount_cents = v_paid, paid_at = new.posted_at
     where id = v_ids[1];

    perform public._agent_log(new.user_id, 'agent.bill_paid', 'bill', v_ids[1]::text,
      jsonb_build_object('description', new.description, 'amount_cents', v_paid));
  end if;

  return null;
end;
$$;

create trigger transactions_match_bill
  after insert on public.transactions
  for each row execute function public.transactions_match_bill();

-- Excluir a transação reabre o boleto por completo.
create function public.bills_clear_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.paid_transaction_id is null and old.paid_transaction_id is not null then
    new.paid_amount_cents := null;
    new.paid_at := null;
  end if;
  return new;
end;
$$;

create trigger bills_clear_payment
  before update on public.bills
  for each row execute function public.bills_clear_payment();

revoke all on function public.transactions_match_bill() from public, anon, authenticated;
revoke all on function public.bills_clear_payment() from public, anon, authenticated;

notify pgrst, 'reload schema';
