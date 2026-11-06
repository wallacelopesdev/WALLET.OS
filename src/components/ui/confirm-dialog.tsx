"use client";

import { Button } from "./button";
import { Modal } from "./modal";

type Props = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <p className="text-sm text-muted">{description}</p>
      <div className="mt-6 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button onClick={onConfirm} disabled={pending}>
          {pending ? "Aguarde…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
