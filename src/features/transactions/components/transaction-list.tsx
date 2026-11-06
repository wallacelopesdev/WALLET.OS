"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { ArrowRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { Account } from "@/features/accounts/queries";
import { CategoryIcon } from "@/features/categories/components/category-icon";
import type { Category } from "@/features/categories/queries";
import { cn, formatBRL, formatDateFull } from "@/lib/utils";
import { deleteTransaction } from "../actions";
import { KIND_LABELS, PAYMENT_METHOD_LABELS } from "../constants";
import type { TransactionItem } from "../queries";
import { TransactionForm } from "./transaction-form";

/**
 * Guarda só o id, e não uma cópia do lançamento: o item sempre vem da lista mais
 * recente, então o formulário nunca abre com dados de antes da última gravação.
 */
type Dialog = { type: "edit" | "view" | "delete"; id: string } | null;

/** Estornos e registros antigos sem par não têm formulário: podem só ser excluídos. */
function isEditable(item: TransactionItem): boolean {
  // Compras no cartão são editadas pela fatura: uma parcela não muda sozinha.
  if (item.cardId) return false;
  return (
    item.kind === "income" ||
    item.kind === "expense" ||
    (item.kind === "transfer" && Boolean(item.transferGroupId))
  );
}

function Amount({ item }: { item: TransactionItem }) {
  const isTransfer = item.kind === "transfer" || item.kind === "invoice_payment";
  return (
    <span
      className={cn(
        "shrink-0 text-sm font-medium tabular-nums",
        !isTransfer && item.amountCents > 0 && "text-positive",
        isTransfer && "text-muted",
      )}
    >
      {!isTransfer && item.amountCents > 0 ? "+" : ""}
      {formatBRL(item.amountCents)}
    </span>
  );
}

export function TransactionList({
  items,
  accounts,
  categories,
  cards,
  readOnly,
}: {
  items: TransactionItem[];
  accounts: Account[];
  categories: Category[];
  cards: { id: string; name: string }[];
  readOnly: boolean;
}) {
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pending, startTransition] = useTransition();
  const close = () => setDialog(null);

  const accountNames = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts],
  );
  const categoriesById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );

  const selected = dialog ? items.find((i) => i.id === dialog.id) : undefined;
  const activeType = selected ? dialog?.type : undefined;

  const open = (item: TransactionItem) =>
    setDialog({ type: isEditable(item) ? "edit" : "view", id: item.id });

  const remove = (item: TransactionItem) => {
    startTransition(async () => {
      const result = await deleteTransaction(item.id);
      close();
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
    });
  };

  const accountName = (id: string | null) =>
    (id && accountNames.get(id)) || "Conta removida";
  const originName = (item: TransactionItem) =>
    item.cardId && !item.accountId
      ? (cards.find((c) => c.id === item.cardId)?.name ?? "Cartão")
      : accountName(item.accountId);

  return (
    <>
      <ul className="divide-y divide-line">
        {items.map((item) => {
          const category = item.categoryId ? categoriesById.get(item.categoryId) : undefined;
          const isPair = item.kind === "transfer" && item.fromAccountId && item.toAccountId;
          const method = item.paymentMethod ? PAYMENT_METHOD_LABELS[item.paymentMethod] : null;

          const content = (
            <>
              <CategoryIcon
                icon={category?.icon ?? (item.kind === "transfer" ? "repeat" : null)}
                color={category?.color ?? null}
                className="hidden sm:flex"
              />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-medium">{item.description}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-faint">
                  <span className="tabular-nums">{formatDateFull(item.postedAt)}</span>
                  <span aria-hidden>·</span>
                  {isPair ? (
                    <span className="inline-flex flex-wrap items-center gap-1">
                      {accountName(item.fromAccountId)}
                      <ArrowRight aria-label="para" className="h-3 w-3" />
                      {accountName(item.toAccountId)}
                    </span>
                  ) : (
                    <span>{originName(item)}</span>
                  )}
                  {item.installmentTotal && (
                    <>
                      <span aria-hidden>·</span>
                      <span>
                        Parcela {item.installmentNumber}/{item.installmentTotal}
                      </span>
                    </>
                  )}
                  {category ? (
                    <>
                      <span aria-hidden>·</span>
                      <span>{category.name}</span>
                    </>
                  ) : (
                    !isPair && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{KIND_LABELS[item.kind] ?? "Outros"}</span>
                      </>
                    )
                  )}
                  {method && item.kind !== "transfer" && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{method}</span>
                    </>
                  )}
                </span>
              </span>
              <Amount item={item} />
            </>
          );

          const rowClass =
            "-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-3 text-left";

          return (
            <li key={item.id}>
              {readOnly ? (
                <div className={rowClass}>{content}</div>
              ) : (
                <button
                  type="button"
                  onClick={() => open(item)}
                  className={cn(rowClass, "transition-colors hover:bg-raised active:bg-raised")}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <Modal
        open={activeType === "edit"}
        onClose={close}
        title={selected?.kind === "transfer" ? "Editar transferência" : "Editar lançamento"}
      >
        {activeType === "edit" && selected && (
          <>
            <TransactionForm
              // Recomeça se a lista trouxer dados mais novos deste lançamento.
              key={JSON.stringify(selected)}
              accounts={accounts}
              categories={categories}
              transaction={selected}
              onDone={close}
            />
            <div className="mt-4 border-t border-line pt-4">
              <Button
                variant="ghost"
                onClick={() => setDialog({ type: "delete", id: selected.id })}
              >
                <Trash2 aria-hidden className="h-4 w-4" /> Excluir
              </Button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={activeType === "view"} onClose={close} title="Lançamento">
        {activeType === "view" && selected && (
          <>
            <p className="font-medium">{selected.description}</p>
            <p className="mt-1 text-sm text-muted">
              {KIND_LABELS[selected.kind] ?? "Outros"} ·{" "}
              {formatDateFull(selected.postedAt)} · {formatBRL(selected.amountCents)}
            </p>
            <p className="mt-4 text-sm text-muted">
              {selected.invoiceId && selected.cardId ? (
                <>
                  Lançamentos de cartão são editados na{" "}
                  <Link
                    href={`/cartoes/${selected.cardId}/faturas/${selected.invoiceId}`}
                    className="text-fg underline underline-offset-4"
                  >
                    fatura
                  </Link>
                  .
                </>
              ) : (
                "Este tipo de lançamento não pode ser editado aqui."
              )}
            </p>
            <div className="mt-6 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
              <Button variant="secondary" onClick={close}>
                Fechar
              </Button>
              <Button onClick={() => setDialog({ type: "delete", id: selected.id })}>
                <Trash2 aria-hidden className="h-4 w-4" /> Excluir
              </Button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={activeType === "delete"}
        title={selected?.transferGroupId ? "Excluir esta transferência?" : "Excluir este lançamento?"}
        description={
          selected?.transferGroupId
            ? "Os dois lados da transferência serão removidos e os saldos das contas voltam ao valor anterior. Esta ação é permanente."
            : selected?.installmentTotal
              ? `As ${selected.installmentTotal} parcelas desta compra serão removidas. Esta ação é permanente.`
              : selected?.cardId && !selected.accountId
                ? "A compra será removida da fatura. Esta ação é permanente."
                : "O saldo da conta será recalculado sem este lançamento. Esta ação é permanente."
        }
        confirmLabel="Excluir"
        pending={pending}
        onCancel={close}
        onConfirm={() => {
          if (activeType === "delete" && selected) remove(selected);
        }}
      />
    </>
  );
}
