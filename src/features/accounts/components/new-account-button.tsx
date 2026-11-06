"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { AccountForm } from "./account-form";

export function NewAccountButton({ label = "Nova conta" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden className="h-4 w-4" />
        {label}
      </Button>
      <Modal open={open} onClose={close} title="Nova conta">
        <AccountForm onDone={close} />
      </Modal>
    </>
  );
}
