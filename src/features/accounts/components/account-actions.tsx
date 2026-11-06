"use client";

import { useState, useTransition } from "react";
import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-result";
import { formatBRL } from "@/lib/utils";
import { archiveAccount, deleteAccount, unarchiveAccount } from "../actions";
import type { Account } from "../queries";
import { AccountForm } from "./account-form";

type Dialog = "edit" | "archive" | "delete" | null;

export function AccountActions({
  account,
  hasMovements,
}: {
  account: Account;
  hasMovements: boolean;
}) {
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

  const archiveDescription =
    account.balanceCents !== 0
      ? `Esta conta tem saldo de ${formatBRL(account.balanceCents)}, que deixará de contar no seu saldo total. O histórico é preservado e você pode reativá-la quando quiser.`
      : "A conta sai da lista de contas ativas. O histórico é preservado e você pode reativá-la quando quiser.";

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => setDialog("edit")}>
        <Pencil aria-hidden className="h-4 w-4" /> Editar
      </Button>

      {account.archived ? (
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => run(() => unarchiveAccount(account.id))}
        >
          <ArchiveRestore aria-hidden className="h-4 w-4" /> Reativar
        </Button>
      ) : (
        <Button variant="secondary" onClick={() => setDialog("archive")}>
          <Archive aria-hidden className="h-4 w-4" /> Arquivar
        </Button>
      )}

      {!hasMovements && (
        <Button variant="ghost" onClick={() => setDialog("delete")}>
          <Trash2 aria-hidden className="h-4 w-4" /> Excluir
        </Button>
      )}

      <Modal open={dialog === "edit"} onClose={close} title="Editar conta">
        <AccountForm account={account} onDone={close} />
      </Modal>

      <ConfirmDialog
        open={dialog === "archive"}
        title={`Arquivar ${account.name}?`}
        description={archiveDescription}
        confirmLabel="Arquivar"
        pending={pending}
        onCancel={close}
        onConfirm={() => run(() => archiveAccount(account.id))}
      />

      <ConfirmDialog
        open={dialog === "delete"}
        title={`Excluir ${account.name}?`}
        description="Esta ação é permanente. A conta não tem movimentações, então nenhum lançamento será perdido."
        confirmLabel="Excluir conta"
        pending={pending}
        onCancel={close}
        onConfirm={() => run(() => deleteAccount(account.id))}
      />
    </div>
  );
}
