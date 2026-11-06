"use client";

import { useState, useTransition } from "react";
import { Archive, ArchiveRestore, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-result";
import { cn, formatBRL } from "@/lib/utils";
import {
  archiveCategory,
  deleteCategory,
  unarchiveCategory,
} from "../actions";
import type { CategoryKind } from "../constants";
import type { CategoryWithTotals } from "../queries";
import { CategoryForm } from "./category-form";
import { CategoryIcon } from "./category-icon";

/** Guarda só o id: os dados sempre vêm da lista mais recente, nunca de uma cópia. */
type Dialog =
  | { type: "new"; kind: CategoryKind }
  | { type: "edit" | "archive" | "delete"; id: string }
  | null;

function Row({
  category,
  readOnly,
  onSelect,
}: {
  category: CategoryWithTotals;
  readOnly: boolean;
  onSelect: () => void;
}) {
  const content = (
    <>
      <CategoryIcon icon={category.icon} color={category.color} archived={category.archived} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm font-medium", category.archived && "text-muted")}>
          {category.name}
        </span>
        <span className="block text-xs text-faint">
          {category.periodCount === 1 ? "1 lançamento" : `${category.periodCount} lançamentos`} no mês
        </span>
      </span>
      <span className={cn("shrink-0 text-sm font-medium tabular-nums", category.periodCents === 0 && "text-faint")}>
        {formatBRL(category.periodCents)}
      </span>
    </>
  );
  const rowClass = "-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-3 text-left";

  return (
    <li>
      {readOnly ? (
        <div className={rowClass}>{content}</div>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className={cn(rowClass, "transition-colors hover:bg-raised active:bg-raised")}
        >
          {content}
        </button>
      )}
    </li>
  );
}

function Section({
  title,
  categories,
  readOnly,
  onSelect,
  onNew,
}: {
  title: string;
  categories: CategoryWithTotals[];
  readOnly: boolean;
  onSelect: (category: CategoryWithTotals) => void;
  onNew?: () => void;
}) {
  const total = categories.reduce((sum, c) => sum + c.periodCents, 0);

  return (
    <Card className="animate-rise">
      <div className="flex items-center justify-between gap-3">
        <CardTitle>{title}</CardTitle>
        <span className="text-sm font-medium tabular-nums">{formatBRL(total)}</span>
      </div>
      {categories.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Nenhuma categoria ativa.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {categories.map((c) => (
            <Row key={c.id} category={c} readOnly={readOnly} onSelect={() => onSelect(c)} />
          ))}
        </ul>
      )}
      {onNew && (
        <Button variant="ghost" onClick={onNew} className="mt-2 w-full">
          <Plus aria-hidden className="h-4 w-4" /> Nova categoria
        </Button>
      )}
    </Card>
  );
}

export function CategoryManager({
  categories,
  readOnly,
}: {
  categories: CategoryWithTotals[];
  readOnly: boolean;
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

  const active = categories.filter((c) => !c.archived);
  const archived = categories.filter((c) => c.archived);
  const selected =
    dialog && dialog.type !== "new" ? categories.find((c) => c.id === dialog.id) : undefined;
  const edited = dialog?.type === "edit" ? selected : undefined;
  const canDelete = edited && !edited.isSystem && edited.totalCount === 0;

  return (
    <>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <Section
          title="Despesas"
          categories={active.filter((c) => c.kind === "expense")}
          readOnly={readOnly}
          onSelect={(category) => setDialog({ type: "edit", id: category.id })}
          onNew={readOnly ? undefined : () => setDialog({ type: "new", kind: "expense" })}
        />
        <Section
          title="Receitas"
          categories={active.filter((c) => c.kind === "income")}
          readOnly={readOnly}
          onSelect={(category) => setDialog({ type: "edit", id: category.id })}
          onNew={readOnly ? undefined : () => setDialog({ type: "new", kind: "income" })}
        />
      </div>

      {archived.length > 0 && (
        <Card className="mt-3 animate-rise">
          <details>
            <summary className="flex min-h-6 cursor-pointer list-none items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-muted">
              <span>Arquivadas</span>
              <span className="tabular-nums">{archived.length}</span>
            </summary>
            <ul className="mt-2 divide-y divide-line">
              {archived.map((c) => (
                <Row
                  key={c.id}
                  category={c}
                  readOnly={readOnly}
                  onSelect={() => setDialog({ type: "edit", id: c.id })}
                />
              ))}
            </ul>
          </details>
        </Card>
      )}

      <Modal open={dialog?.type === "new"} onClose={close} title="Nova categoria">
        {dialog?.type === "new" && <CategoryForm defaultKind={dialog.kind} onDone={close} />}
      </Modal>

      <Modal open={Boolean(edited)} onClose={close} title="Editar categoria">
        {edited && (
          <>
            <CategoryForm key={JSON.stringify(edited)} category={edited} onDone={close} />
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              {edited.archived ? (
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => unarchiveCategory(edited.id))}
                >
                  <ArchiveRestore aria-hidden className="h-4 w-4" /> Reativar
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => setDialog({ type: "archive", id: edited.id })}
                >
                  <Archive aria-hidden className="h-4 w-4" /> Arquivar
                </Button>
              )}
              {canDelete && (
                <Button
                  variant="ghost"
                  onClick={() => setDialog({ type: "delete", id: edited.id })}
                >
                  <Trash2 aria-hidden className="h-4 w-4" /> Excluir
                </Button>
              )}
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={dialog?.type === "archive" && Boolean(selected)}
        title={`Arquivar ${selected?.name ?? "categoria"}?`}
        description="A categoria deixa de aparecer em novos lançamentos. Os lançamentos existentes continuam com ela, e você pode reativá-la quando quiser."
        confirmLabel="Arquivar"
        pending={pending}
        onCancel={close}
        onConfirm={() => {
          if (dialog?.type === "archive") run(() => archiveCategory(dialog.id));
        }}
      />

      <ConfirmDialog
        open={dialog?.type === "delete" && Boolean(selected)}
        title={`Excluir ${selected?.name ?? "categoria"}?`}
        description="Esta ação é permanente. A categoria não tem lançamentos, então nenhum histórico será afetado."
        confirmLabel="Excluir categoria"
        pending={pending}
        onCancel={close}
        onConfirm={() => {
          if (dialog?.type === "delete") run(() => deleteCategory(dialog.id));
        }}
      />
    </>
  );
}
