"use client";

import { useActionState, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select, fieldAria } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { Account } from "@/features/accounts/queries";
import type { Category } from "@/features/categories/queries";
import type { ActionResult } from "@/lib/action-result";
import { cn, formatBRL, formatDateFull } from "@/lib/utils";
import { deletePurchase, undoPayment, updatePurchase } from "../actions";
import type { InvoiceEntry } from "../queries";

function EditPurchaseForm({
  entry,
  categories,
  onDone,
}: {
  entry: InvoiceEntry;
  categories: Category[];
  onDone: () => void;
}) {
  const toast = useToast();
  const [description, setDescription] = useState(entry.description);
  const [categoryId, setCategoryId] = useState(entry.categoryId ?? "");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      const result = await updatePurchase(entry.id, previous, formData);
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
      <Field label="Descrição" htmlFor="entry-description" error={errors.description}>
        <Input
          {...fieldAria("entry-description", errors.description)}
          name="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={200}
          autoComplete="off"
        />
      </Field>
      <Field label="Categoria" htmlFor="entry-category" error={errors.categoryId}>
        <Select
          {...fieldAria("entry-category", errors.categoryId)}
          name="categoryId"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Sem categoria</option>
          {categories
            .filter((c) => c.kind === "expense" && (!c.archived || c.id === entry.categoryId))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </Select>
      </Field>
      <p className="text-xs text-muted">
        {entry.installmentTotal
          ? `A alteração vale para todas as ${entry.installmentTotal} parcelas. `
          : ""}
        Para mudar o valor ou a data, exclua e registre a compra de novo.
      </p>
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
          {pending ? "Salvando…" : "Salvar alterações"}
        </Button>
      </div>
    </form>
  );
}

/** Guarda só o id: os dados sempre vêm da lista mais recente. */
type Dialog = { type: "edit" | "delete" | "undo"; id: string } | null;

export function InvoiceEntries({
  purchases,
  payments,
  accounts,
  categories,
  readOnly,
}: {
  purchases: InvoiceEntry[];
  payments: InvoiceEntry[];
  accounts: Account[];
  categories: Category[];
  readOnly: boolean;
}) {
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pending, startTransition] = useTransition();
  const close = () => setDialog(null);

  const selected = dialog
    ? [...purchases, ...payments].find((entry) => entry.id === dialog.id)
    : undefined;
  const activeType = selected ? dialog?.type : undefined;

  const run = (operation: () => Promise<ActionResult>) => {
    startTransition(async () => {
      const result = await operation();
      close();
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
    });
  };

  const categoryName = (id: string | null) =>
    id ? categories.find((c) => c.id === id)?.name : undefined;
  const accountName = (id: string | null) =>
    id ? accounts.find((a) => a.id === id)?.name : undefined;

  const rowClass = "-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-3 text-left";

  return (
    <>
      <section aria-label="Compras">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Compras</h2>
        {purchases.length === 0 ? (
          <p className="mt-4 text-sm text-muted">Nenhuma compra nesta fatura.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {purchases.map((p) => {
              const content = (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium">{p.description}</span>
                    <span className="mt-0.5 block text-xs text-faint">
                      {[
                        formatDateFull(p.postedAt),
                        p.installmentTotal ? `Parcela ${p.installmentNumber}/${p.installmentTotal}` : null,
                        categoryName(p.categoryId),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-medium tabular-nums">
                    {formatBRL(Math.abs(p.amountCents))}
                  </span>
                </>
              );
              return (
                <li key={p.id}>
                  {readOnly ? (
                    <div className={rowClass}>{content}</div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDialog({ type: "edit", id: p.id })}
                      className={cn(rowClass, "transition-colors hover:bg-raised active:bg-raised")}
                    >
                      {content}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {payments.length > 0 && (
        <section aria-label="Pagamentos" className="mt-6 border-t border-line pt-5">
          <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Pagamentos</h2>
          <ul className="mt-2 divide-y divide-line">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium tabular-nums">
                    {formatBRL(Math.abs(p.amountCents))}
                  </span>
                  <span className="mt-0.5 block text-xs text-faint">
                    {[formatDateFull(p.postedAt), accountName(p.accountId)].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {!readOnly && (
                  <Button variant="ghost" onClick={() => setDialog({ type: "undo", id: p.id })}>
                    Desfazer
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Modal open={activeType === "edit"} onClose={close} title="Editar compra">
        {activeType === "edit" && selected && (
          <>
            <EditPurchaseForm
              key={JSON.stringify(selected)}
              entry={selected}
              categories={categories}
              onDone={close}
            />
            <div className="mt-4 border-t border-line pt-4">
              <Button variant="ghost" onClick={() => setDialog({ type: "delete", id: selected.id })}>
                <Trash2 aria-hidden className="h-4 w-4" /> Excluir compra
              </Button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={activeType === "delete"}
        title="Excluir esta compra?"
        description={
          selected?.installmentTotal
            ? `As ${selected.installmentTotal} parcelas serão removidas de todas as faturas. Esta ação é permanente.`
            : "A compra será removida da fatura. Esta ação é permanente."
        }
        confirmLabel="Excluir"
        pending={pending}
        onCancel={close}
        onConfirm={() => {
          if (selected) run(() => deletePurchase(selected.id));
        }}
      />

      <ConfirmDialog
        open={activeType === "undo"}
        title="Desfazer este pagamento?"
        description="O valor volta para a conta e a fatura deixa de contar este pagamento."
        confirmLabel="Desfazer pagamento"
        pending={pending}
        onCancel={close}
        onConfirm={() => {
          if (selected) run(() => undoPayment(selected.id));
        }}
      />
    </>
  );
}
