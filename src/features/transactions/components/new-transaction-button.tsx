"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { Account } from "@/features/accounts/queries";
import type { Category } from "@/features/categories/queries";
import { TransactionForm } from "./transaction-form";

export function NewTransactionButton({
  accounts,
  categories,
  defaultAccountId,
  label = "Novo lançamento",
}: {
  accounts: Account[];
  categories: Category[];
  defaultAccountId?: string | null;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden className="h-4 w-4" />
        {label}
      </Button>
      <Modal open={open} onClose={close} title="Novo lançamento">
        <TransactionForm
          accounts={accounts}
          categories={categories}
          defaultAccountId={defaultAccountId}
          onDone={close}
        />
      </Modal>
    </>
  );
}
