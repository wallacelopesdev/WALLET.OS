"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, fieldAria, inputClass } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import type { Account } from "@/features/accounts/queries";
import type { Category } from "@/features/categories/queries";
import type { ActionResult } from "@/lib/action-result";
import { todayInSaoPaulo } from "@/lib/dates";
import { newRequestId } from "@/lib/request-id";
import { cn } from "@/lib/utils";
import {
  createTransaction,
  createTransfer,
  updateTransaction,
  updateTransfer,
} from "../actions";
import {
  EDITABLE_KINDS,
  KIND_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type EditableKind,
} from "../constants";
import type { TransactionItem } from "../queries";

function accountLabel(account: Account): string {
  return account.institution ? `${account.name} · ${account.institution}` : account.name;
}

export function TransactionForm({
  accounts,
  categories,
  transaction,
  defaultAccountId,
  onDone,
}: {
  accounts: Account[];
  categories: Category[];
  transaction?: TransactionItem;
  defaultAccountId?: string | null;
  onDone: () => void;
}) {
  const toast = useToast();
  const isEdit = Boolean(transaction);
  const isTransferEdit = transaction?.kind === "transfer";
  const today = todayInSaoPaulo();

  const usable = (id: string | null | undefined) =>
    accounts.filter((a) => !a.archived || a.id === id);
  const activeAccounts = accounts.filter((a) => !a.archived);
  const firstAccount =
    (defaultAccountId && activeAccounts.some((a) => a.id === defaultAccountId)
      ? defaultAccountId
      : activeAccounts[0]?.id) ?? "";

  const [requestId] = useState(newRequestId);
  const [kind, setKind] = useState<EditableKind>(
    (transaction?.kind as EditableKind | undefined) ?? "expense",
  );
  const [description, setDescription] = useState(transaction?.description ?? "");
  const [accountId, setAccountId] = useState(transaction?.accountId ?? firstAccount);
  const [fromAccountId, setFromAccountId] = useState(transaction?.fromAccountId ?? firstAccount);
  const [toAccountId, setToAccountId] = useState(
    transaction?.toAccountId ?? activeAccounts.find((a) => a.id !== firstAccount)?.id ?? "",
  );
  const [categoryId, setCategoryId] = useState(transaction?.categoryId ?? "");
  const [postedAt, setPostedAt] = useState(transaction?.postedAt ?? today);
  const [competenceDate, setCompetenceDate] = useState(transaction?.competenceDate ?? "");
  const [paymentMethod, setPaymentMethod] = useState<string>(transaction?.paymentMethod ?? "");
  const [notes, setNotes] = useState(transaction?.notes ?? "");

  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      let result: ActionResult;
      if (kind === "transfer") {
        result = transaction?.transferGroupId
          ? await updateTransfer(transaction.transferGroupId, previous, formData)
          : await createTransfer(previous, formData);
      } else {
        result = transaction
          ? await updateTransaction(transaction.id, previous, formData)
          : await createTransaction(previous, formData);
      }
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
  const isTransfer = kind === "transfer";

  const categoryOptions = categories.filter(
    (c) => c.kind === kind && (!c.archived || c.id === transaction?.categoryId),
  );

  const changeKind = (next: EditableKind) => {
    setKind(next);
    // A categoria de um tipo não vale para o outro.
    if (!categories.some((c) => c.id === categoryId && c.kind === next)) setCategoryId("");
  };

  const hasEnoughForTransfer = isEdit || activeAccounts.length >= 2;

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="kind" value={kind} />

      {!isTransferEdit && (
        <div
          role="group"
          aria-label="Tipo de lançamento"
          className={cn(
            "grid gap-1 rounded-xl border border-line-strong p-1",
            isEdit ? "grid-cols-2" : "grid-cols-3",
          )}
        >
          {EDITABLE_KINDS.filter((k) => !isEdit || k !== "transfer").map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => changeKind(k)}
              aria-pressed={kind === k}
              className={cn(
                "min-h-10 rounded-lg text-sm transition-colors",
                kind === k ? "bg-fg font-medium text-ink" : "text-muted hover:text-fg",
              )}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
      )}

      {isTransfer && !hasEnoughForTransfer ? (
        <p className="rounded-xl border border-line-strong bg-raised px-4 py-3 text-sm text-muted">
          Para transferir, você precisa de pelo menos duas contas ativas.
        </p>
      ) : (
        <>
          <Field label="Valor" htmlFor="tx-amount" error={errors.amount}>
            <MoneyInput
              key={transaction?.id ?? "new"}
              id="tx-amount"
              name="amount"
              defaultCents={transaction ? Math.abs(transaction.amountCents) : 0}
              invalid={Boolean(errors.amount)}
              describedBy={errors.amount ? "tx-amount-error" : undefined}
            />
          </Field>

          {isTransfer ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="De" htmlFor="tx-from" error={errors.fromAccountId}>
                <Select
                  {...fieldAria("tx-from", errors.fromAccountId)}
                  name="fromAccountId"
                  value={fromAccountId}
                  onChange={(e) => setFromAccountId(e.target.value)}
                >
                  {usable(transaction?.fromAccountId).map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountLabel(a)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Para" htmlFor="tx-to" error={errors.toAccountId}>
                <Select
                  {...fieldAria("tx-to", errors.toAccountId)}
                  name="toAccountId"
                  value={toAccountId}
                  onChange={(e) => setToAccountId(e.target.value)}
                >
                  {usable(transaction?.toAccountId).map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountLabel(a)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : (
            <Field label="Conta" htmlFor="tx-account" error={errors.accountId}>
              <Select
                {...fieldAria("tx-account", errors.accountId)}
                name="accountId"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {usable(transaction?.accountId).map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label={isTransfer ? "Descrição (opcional)" : "Descrição"}
            htmlFor="tx-description"
            error={errors.description}
          >
            <Input
              {...fieldAria("tx-description", errors.description)}
              name="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={isTransfer ? "Transferência" : "Ex.: Mercado"}
              maxLength={200}
              autoComplete="off"
            />
          </Field>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Data da movimentação" htmlFor="tx-date" error={errors.postedAt}>
              <Input
                {...fieldAria("tx-date", errors.postedAt)}
                type="date"
                name="postedAt"
                value={postedAt}
                max={today}
                onChange={(e) => setPostedAt(e.target.value)}
              />
            </Field>

            {!isTransfer && (
              <Field
                label="Competência (opcional)"
                htmlFor="tx-competence"
                error={errors.competenceDate}
              >
                <Input
                  {...fieldAria("tx-competence", errors.competenceDate)}
                  type="date"
                  name="competenceDate"
                  value={competenceDate}
                  onChange={(e) => setCompetenceDate(e.target.value)}
                />
              </Field>
            )}
          </div>

          {!isTransfer && (
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Categoria" htmlFor="tx-category" error={errors.categoryId}>
                <Select
                  {...fieldAria("tx-category", errors.categoryId)}
                  name="categoryId"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                >
                  <option value="">Sem categoria</option>
                  {categoryOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Método de pagamento"
                htmlFor="tx-method"
                error={errors.paymentMethod}
                hint={
                  paymentMethod === "credit"
                    ? "Este lançamento debita a conta agora. Compras no cartão terão fluxo próprio no módulo de Cartões."
                    : undefined
                }
              >
                <Select
                  {...fieldAria("tx-method", errors.paymentMethod)}
                  name="paymentMethod"
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                >
                  <option value="">Não informado</option>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}

          <Field label="Observações (opcional)" htmlFor="tx-notes" error={errors.notes}>
            <textarea
              {...fieldAria("tx-notes", errors.notes)}
              name="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              rows={2}
              className={inputClass}
            />
          </Field>
        </>
      )}

      {formError && (
        <p role="alert" className="rounded-xl border border-line-strong bg-raised px-4 py-3 text-sm">
          {formError}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
        <Button variant="secondary" onClick={onDone} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" disabled={pending || (isTransfer && !hasEnoughForTransfer)}>
          {pending ? "Salvando…" : isEdit ? "Salvar alterações" : "Registrar"}
        </Button>
      </div>
    </form>
  );
}
