"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
};

/**
 * Usa o <dialog> nativo, que já traz foco preso, Esc e camada superior.
 * No celular abre como folha inferior; a partir de md, centralizado.
 * O conteúdo só é montado aberto, então formulários sempre recomeçam limpos.
 */
export function Modal({ open, onClose, title, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      onClose={() => {
        // O evento chega depois do fechamento: ignora o que sobrou de um
        // fechamento anterior se o modal já foi reaberto.
        if (!ref.current?.open) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-0 mt-auto max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-3xl border border-line-strong bg-surface p-0 text-left text-fg backdrop:bg-black/70 open:animate-sheet md:m-auto md:max-w-lg md:rounded-2xl"
    >
      {open && (
        <div
          className="px-5 pt-5 md:px-6 md:pb-6 md:pt-6"
          style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
        >
          <div className="mb-5 flex items-center justify-between gap-4">
            <h2 id="modal-title" className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar"
              className="rounded-full p-1.5 text-muted transition-colors hover:bg-raised hover:text-fg active:bg-raised"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
