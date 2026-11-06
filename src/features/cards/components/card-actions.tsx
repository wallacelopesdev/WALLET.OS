"use client";

import { useState, useTransition } from "react";
import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-result";
import { archiveCard, deleteCard, unarchiveCard } from "../actions";
import type { CardSummary } from "../queries";
import { CardForm } from "./card-form";

type Dialog = "edit" | "archive" | "delete" | null;

export function CardActions({ card }: { card: CardSummary }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pending, startTransition] = useTransition();
  const close = () => setDialog(null);

  const run = (operation: () => Promise<ActionResult>) => {
    startTransition(async () => {
      const result = await operation();
      close();
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
    });
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => setDialog("edit")}>
        <Pencil aria-hidden className="h-4 w-4" /> Editar
      </Button>

      {card.archived ? (
        <Button variant="secondary" disabled={pending} onClick={() => run(() => unarchiveCard(card.id))}>
          <ArchiveRestore aria-hidden className="h-4 w-4" /> Reativar
        </Button>
      ) : (
        <Button variant="secondary" onClick={() => setDialog("archive")}>
          <Archive aria-hidden className="h-4 w-4" /> Arquivar
        </Button>
      )}

      {card.invoiceCount === 0 && (
        <Button variant="ghost" onClick={() => setDialog("delete")}>
          <Trash2 aria-hidden className="h-4 w-4" /> Excluir
        </Button>
      )}

      <Modal open={dialog === "edit"} onClose={close} title="Editar cartão">
        <CardForm card={card} onDone={close} />
        <p className="mt-3 text-xs text-muted">
          Mudar os dias de fechamento ou vencimento vale para as faturas novas. As já criadas não mudam.
        </p>
      </Modal>

      <ConfirmDialog
        open={dialog === "archive"}
        title={`Arquivar ${card.name}?`}
        description="O cartão deixa de aceitar novas compras. As faturas e o histórico são preservados, e você pode reativá-lo quando quiser."
        confirmLabel="Arquivar"
        pending={pending}
        onCancel={close}
        onConfirm={() => run(() => archiveCard(card.id))}
      />

      <ConfirmDialog
        open={dialog === "delete"}
        title={`Excluir ${card.name}?`}
        description="Esta ação é permanente. O cartão não tem faturas, então nenhum lançamento será perdido."
        confirmLabel="Excluir cartão"
        pending={pending}
        onCancel={close}
        onConfirm={() => run(() => deleteCard(card.id))}
      />
    </div>
  );
}
