"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, fieldAria } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import type { Account } from "@/features/accounts/queries";
import type { ActionResult } from "@/lib/action-result";
import { todayInSaoPaulo } from "@/lib/dates";
import { newRequestId } from "@/lib/request-id";
import { formatBRL } from "@/lib/utils";
import { payInvoice } from "../actions";

function PayForm({
  invoiceId,
  remaining,
  accounts,
  onDone,
}: {
  invoiceId: string;
  remaining: number;
  accounts: Account[];
  onDone: () => void;
}) {
  const toast = useToast();
  const today = todayInSaoPaulo();
  const [requestId] = useState(newRequestId);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [paidAt, setPaidAt] = useState(today);

  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      const result = await payInvoice(previous, formData);
      if (result.ok) {
        toast.success(result.message);
        onDone();
      }
      return result;
    },
    null,
  );

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok ? state.error : null;

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="invoiceId" value={invoiceId} />

      <p className="text-sm text-muted">
        Saldo em aberto: <span className="font-medium tabular-nums text-fg">{formatBRL(remaining)}</span>.
        O valor sai da conta escolhida e não conta como nova despesa, pois as compras já foram contadas.
      </p>

      <Field label="Valor do pagamento" htmlFor="pay-amount" error={errors.amount}>
        <MoneyInput
          id="pay-amount"
          name="amount"
          defaultCents={remaining}
          invalid={Boolean(errors.amount)}
          describedBy={errors.amount ? "pay-amount-error" : undefined}
        />
      </Field>

      <Field label="Conta" htmlFor="pay-account" error={errors.accountId}>
        <Select
          {...fieldAria("pay-account", errors.accountId)}
          name="accountId"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.institution ? `${a.name} · ${a.institution}` : a.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Data do pagamento" htmlFor="pay-date" error={errors.paidAt}>
        <Input
          {...fieldAria("pay-date", errors.paidAt)}
          type="date"
          name="paidAt"
          value={paidAt}
          max={today}
          onChange={(e) => setPaidAt(e.target.value)}
        />
      </Field>

      {formError && (
        <p role="alert" className="rounded-xl border border-line-strong bg-raised px-4 py-3 text-sm">
          {formError}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
        <Button variant="secondary" onClick={onDone} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Salvando…" : "Registrar pagamento"}
        </Button>
      </div>
    </form>
  );
}

export function PayInvoiceButton({
  invoiceId,
  remaining,
  accounts,
}: {
  invoiceId: string;
  remaining: number;
  accounts: Account[];
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const active = accounts.filter((a) => !a.archived);

  if (active.length === 0) {
    return <p className="text-sm text-muted">Cadastre uma conta para registrar o pagamento.</p>;
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Pagar fatura</Button>
      <Modal open={open} onClose={close} title="Pagar fatura">
        <PayForm invoiceId={invoiceId} remaining={remaining} accounts={active} onDone={close} />
      </Modal>
    </>
  );
}
