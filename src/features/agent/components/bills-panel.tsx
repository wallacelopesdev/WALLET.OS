"use client";

import { useActionState, useState, useTransition } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, fieldAria } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-result";
import { todayInSaoPaulo } from "@/lib/dates";
import { cn, formatBRL, formatDateFull } from "@/lib/utils";
import { createBill, dismissBill } from "../bills";

export type Bill = {
  id: string;
  beneficiary: string;
  amountCents: number;
  dueDate: string;
  paidAt: string | null;
  paidAmountCents: number | null;
};

export function BillsPanel({ bills }: { bills: Bill[] }) {
  const toast = useToast();
  const today = todayInSaoPaulo();
  const [beneficiary, setBeneficiary] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [formKey, setFormKey] = useState(0);
  const [pending, startTransition] = useTransition();
  const [state, action, saving] = useActionState<ActionResult | null, FormData>(async (previous, formData) => {
    const result = await createBill(previous, formData);
    if (result.ok) {
      toast.success(result.message);
      setBeneficiary("");
      setDueDate("");
      setFormKey((k) => k + 1);
    }
    return result;
  }, null);

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const open = bills.filter((b) => !b.paidAt);
  const paid = bills.filter((b) => b.paidAt);

  return (
    <>
      <Card className="animate-rise">
        <CardTitle>Em aberto</CardTitle>
        <p className="mt-3 text-sm text-muted">
          Os bancos não informam boletos pendentes pelo Open Finance. Cadastre aqui os que espera pagar. Um boleto só
          aparece como pago quando o pagamento é confirmado por uma transação.
        </p>
        {open.length === 0 ? (
          <EmptyState icon={FileText} title="Nenhum boleto em aberto" description="Cadastre um boleto para acompanhar o vencimento." />
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {open.map((bill) => {
              const overdue = bill.dueDate < today;
              return (
                <li key={bill.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{bill.beneficiary}</p>
                    <p className={cn("text-xs", overdue ? "text-fg" : "text-faint")}>
                      {overdue ? "Vencido em " : "Vence em "}
                      {formatDateFull(bill.dueDate)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm font-medium tabular-nums">{formatBRL(bill.amountCents)}</span>
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await dismissBill(bill.id);
                          if (result.ok) toast.success(result.message);
                          else toast.error(result.error);
                        })
                      }
                    >
                      Dispensar
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="mt-3 animate-rise">
        <CardTitle>Cadastrar boleto</CardTitle>
        <form key={formKey} action={action} className="mt-3 grid gap-4 md:grid-cols-3" noValidate>
          <Field label="Beneficiário" htmlFor="bill-beneficiary" error={errors.beneficiary}>
            <Input
              {...fieldAria("bill-beneficiary", errors.beneficiary)}
              name="beneficiary"
              value={beneficiary}
              onChange={(e) => setBeneficiary(e.target.value)}
              maxLength={120}
              autoComplete="off"
            />
          </Field>
          <Field label="Valor" htmlFor="bill-amount" error={errors.amount}>
            <MoneyInput id="bill-amount" name="amount" invalid={Boolean(errors.amount)} />
          </Field>
          <Field label="Vencimento" htmlFor="bill-due" error={errors.dueDate}>
            <Input
              {...fieldAria("bill-due", errors.dueDate)}
              type="date"
              name="dueDate"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </Field>
          <div className="md:col-span-3">
            <Button type="submit" disabled={saving}>
              {saving ? "Salvando…" : "Cadastrar boleto"}
            </Button>
          </div>
        </form>
      </Card>

      {paid.length > 0 && (
        <Card className="mt-3 animate-rise">
          <CardTitle>Pagos</CardTitle>
          <ul className="mt-2 divide-y divide-line">
            {paid.map((bill) => (
              <li key={bill.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{bill.beneficiary}</p>
                  <p className="text-xs text-faint">Pago em {formatDateFull(bill.paidAt as string)}</p>
                </div>
                <span className="shrink-0 text-sm tabular-nums text-muted">
                  {formatBRL(bill.paidAmountCents ?? bill.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
