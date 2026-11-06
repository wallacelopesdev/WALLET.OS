"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, fieldAria, inputClass } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import type { Category } from "@/features/categories/queries";
import type { ActionResult } from "@/lib/action-result";
import { todayInSaoPaulo } from "@/lib/dates";
import { newRequestId } from "@/lib/request-id";
import { createPurchase } from "../actions";

function PurchaseForm({
  cardId,
  categories,
  onDone,
}: {
  cardId: string;
  categories: Category[];
  onDone: () => void;
}) {
  const toast = useToast();
  const today = todayInSaoPaulo();
  const [requestId] = useState(newRequestId);
  const [description, setDescription] = useState("");
  const [installments, setInstallments] = useState("1");
  const [postedAt, setPostedAt] = useState(today);
  const [categoryId, setCategoryId] = useState("");
  const [notes, setNotes] = useState("");

  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      const result = await createPurchase(previous, formData);
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
      <input type="hidden" name="cardId" value={cardId} />

      <Field
        label="Valor total da compra"
        htmlFor="purchase-amount"
        error={errors.amount}
        hint="Compras no cartão não debitam nenhuma conta. O saldo só muda quando a fatura é paga."
      >
        <MoneyInput
          id="purchase-amount"
          name="amount"
          invalid={Boolean(errors.amount)}
          describedBy={errors.amount ? "purchase-amount-error" : undefined}
        />
      </Field>

      <Field label="Descrição" htmlFor="purchase-description" error={errors.description}>
        <Input
          {...fieldAria("purchase-description", errors.description)}
          name="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ex.: Mercado"
          maxLength={200}
          autoComplete="off"
        />
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Parcelas" htmlFor="purchase-installments" error={errors.installments}>
          <Select
            {...fieldAria("purchase-installments", errors.installments)}
            name="installments"
            value={installments}
            onChange={(e) => setInstallments(e.target.value)}
          >
            {Array.from({ length: 48 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n === 1 ? "À vista" : `${n}x`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Data da compra" htmlFor="purchase-date" error={errors.postedAt}>
          <Input
            {...fieldAria("purchase-date", errors.postedAt)}
            type="date"
            name="postedAt"
            value={postedAt}
            max={today}
            onChange={(e) => setPostedAt(e.target.value)}
          />
        </Field>
      </div>

      <Field label="Categoria" htmlFor="purchase-category" error={errors.categoryId}>
        <Select
          {...fieldAria("purchase-category", errors.categoryId)}
          name="categoryId"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Sem categoria</option>
          {categories
            .filter((c) => c.kind === "expense" && !c.archived)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </Select>
      </Field>

      <Field label="Observações (opcional)" htmlFor="purchase-notes" error={errors.notes}>
        <textarea
          {...fieldAria("purchase-notes", errors.notes)}
          name="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={1000}
          rows={2}
          className={inputClass}
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
          {pending ? "Salvando…" : "Registrar compra"}
        </Button>
      </div>
    </form>
  );
}

export function PurchaseButton({ cardId, categories }: { cardId: string; categories: Category[] }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden className="h-4 w-4" /> Nova compra
      </Button>
      <Modal open={open} onClose={close} title="Nova compra no cartão">
        <PurchaseForm cardId={cardId} categories={categories} onDone={close} />
      </Modal>
    </>
  );
}
