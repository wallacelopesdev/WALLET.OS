"use client";

import { useState, useTransition } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { Category } from "@/features/categories/queries";
import { cn, formatBRL, formatTimestampDate } from "@/lib/utils";
import { finishImport, importChunk, previewStatement, startImport, type PreviewRow } from "../import/actions";
import type { TargetOption } from "./pending-panel";

type EditableRow = PreviewRow & { selected: boolean; categoryId: string };

type Outcome = { inserted: number; duplicated: number; pending: number; failed: number };

export type BatchSummary = {
  id: string;
  fileName: string | null;
  format: string;
  status: string;
  total: number;
  inserted: number;
  duplicated: number;
  error: string | null;
  createdAt: string;
};

const CHUNK = 50;

export function ImportPanel({
  targets,
  categories,
  batches,
}: {
  targets: TargetOption[];
  categories: Category[];
  batches: BatchSummary[];
}) {
  const toast = useToast();
  const [target, setTarget] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<EditableRow[] | null>(null);
  const [meta, setMeta] = useState<{ format: "ofx" | "csv"; fileName: string; skipped: number } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setRows(null);
    setMeta(null);
    setFile(null);
  };

  const preview = () => {
    if (!file) return;
    setOutcome(null);
    startTransition(async () => {
      const form = new FormData();
      form.set("file", file);
      form.set("target", target);
      const result = await previewStatement(form);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setMeta({ format: result.format, fileName: result.fileName, skipped: result.skipped });
      setRows(result.rows.map((row) => ({ ...row, selected: !row.alreadyImported, categoryId: "" })));
    });
  };

  const update = (index: number, change: Partial<EditableRow>) =>
    setRows((list) => (list ? list.map((row, i) => (i === index ? { ...row, ...change } : row)) : list));

  const confirm = () => {
    if (!rows || !meta) return;
    const chosen = rows.filter((row) => row.selected);
    if (chosen.length === 0) return;
    startTransition(async () => {
      const started = await startImport({
        format: meta.format,
        fileName: meta.fileName,
        target,
        total: chosen.length,
      });
      if (!started.ok) {
        toast.error(started.error);
        return;
      }

      const totals: Outcome = { inserted: 0, duplicated: 0, pending: 0, failed: 0 };
      for (let i = 0; i < chosen.length; i += CHUNK) {
        setProgress(`Importando ${Math.min(i + CHUNK, chosen.length)} de ${chosen.length}…`);
        const result = await importChunk({
          batchId: started.batchId,
          format: meta.format,
          target,
          rows: chosen.slice(i, i + CHUNK).map((row) => ({
            ref: row.ref,
            date: row.date,
            description: row.description,
            amountCents: row.amountCents,
            categoryId: row.categoryId || null,
          })),
        });
        if (!result.ok) {
          totals.failed += Math.min(CHUNK, chosen.length - i);
          continue;
        }
        totals.inserted += result.inserted;
        totals.duplicated += result.duplicated;
        totals.pending += result.pending;
        totals.failed += result.failed;
      }

      await finishImport({ batchId: started.batchId, ...totals });
      setProgress(null);
      setOutcome(totals);
      reset();
      if (totals.failed > 0) toast.error("A importação terminou com falhas. Veja o resultado.");
      else toast.success("Importação concluída.");
    });
  };

  const selectedCount = rows?.filter((row) => row.selected).length ?? 0;

  return (
    <>
      {outcome && (
        <Card className="mb-3 animate-rise">
          <CardTitle>Resultado da importação</CardTitle>
          <p className="mt-3 text-sm">
            {outcome.inserted} registrados, {outcome.duplicated} já existiam, {outcome.pending} para revisar,{" "}
            {outcome.failed} não importados.
          </p>
          {outcome.failed > 0 && (
            <p className="mt-1 text-xs text-muted">
              Importe o mesmo arquivo de novo para tentar as que faltaram: o que já entrou não será duplicado.
            </p>
          )}
        </Card>
      )}

      {!rows ? (
        <Card className="animate-rise">
          <CardTitle>Importar extrato</CardTitle>
          <p className="mt-3 text-sm text-muted">
            Arquivos OFX ou CSV de até 4 MB. O arquivo é lido uma vez, não é guardado e não é enviado a nenhum serviço
            externo.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Conta ou cartão do extrato" htmlFor="import-target">
              <Select id="import-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Escolha</option>
                {targets.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Arquivo" htmlFor="import-file">
              <Input
                id="import-file"
                type="file"
                accept=".ofx,.qfx,.csv,.txt"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="py-2.5"
              />
            </Field>
          </div>
          <Button className="mt-4" disabled={pending || !file || !target} onClick={preview}>
            <Upload aria-hidden className="h-4 w-4" />
            {pending ? "Lendo…" : "Ler arquivo"}
          </Button>
        </Card>
      ) : (
        <Card className="animate-rise">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Revisar {meta?.fileName}</CardTitle>
            <span className="text-xs text-muted">
              {selectedCount} de {rows.length} selecionadas
              {meta && meta.skipped > 0 ? ` · ${meta.skipped} linhas ignoradas` : ""}
            </span>
          </div>
          <ul className="mt-2 max-h-[60dvh] divide-y divide-line overflow-y-auto">
            {rows.map((row, index) => (
              <li key={row.ref} className="py-3">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Importar ${row.description}`}
                    checked={row.selected}
                    onChange={(e) => update(index, { selected: e.target.checked })}
                    className="mt-3 h-4 w-4 shrink-0 accent-[#fafafa]"
                  />
                  <div className="grid min-w-0 flex-1 gap-2 md:grid-cols-[1fr_9rem_10rem_auto]">
                    <Input
                      aria-label="Descrição"
                      value={row.description}
                      maxLength={200}
                      onChange={(e) => update(index, { description: e.target.value })}
                      className="py-2"
                    />
                    <Input
                      aria-label="Data"
                      type="date"
                      value={row.date}
                      onChange={(e) => update(index, { date: e.target.value })}
                      className="py-2"
                    />
                    <Select
                      aria-label="Categoria"
                      value={row.categoryId}
                      onChange={(e) => update(index, { categoryId: e.target.value })}
                      className="py-2"
                    >
                      <option value="">Automática</option>
                      {categories
                        .filter((c) => !c.archived && c.kind === (row.amountCents > 0 ? "income" : "expense"))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </Select>
                    <button
                      type="button"
                      onClick={() => update(index, { amountCents: -row.amountCents, categoryId: "" })}
                      aria-label={`Inverter entrada e saída de ${row.description}`}
                      className={cn(
                        "min-h-10 rounded-lg px-2 text-right text-sm tabular-nums transition-colors hover:bg-raised",
                        row.amountCents > 0 && "text-positive",
                      )}
                    >
                      {row.amountCents > 0 ? "+" : ""}
                      {formatBRL(row.amountCents)}
                    </button>
                  </div>
                </div>
                {row.alreadyImported && (
                  <p className="ml-7 mt-1 text-xs text-muted">Já importada antes: não será registrada de novo.</p>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Button variant="secondary" disabled={pending} onClick={reset}>
              Cancelar
            </Button>
            <Button disabled={pending || selectedCount === 0} onClick={confirm}>
              {progress ?? `Importar ${selectedCount}`}
            </Button>
          </div>
        </Card>
      )}

      {batches.length > 0 && (
        <Card className="mt-3 animate-rise">
          <CardTitle>Histórico de importações</CardTitle>
          <ul className="mt-2 divide-y divide-line">
            {batches.map((batch) => (
              <li key={batch.id} className="py-3">
                <p className="truncate text-sm font-medium">{batch.fileName ?? batch.format.toUpperCase()}</p>
                <p className="mt-0.5 text-xs text-faint">
                  {formatTimestampDate(batch.createdAt)} · {batch.inserted} registrados de {batch.total} ·{" "}
                  {batch.duplicated} já existiam
                  {batch.status === "failed" ? " · com falhas" : ""}
                </p>
                {batch.error && <p className="mt-0.5 text-xs text-muted">{batch.error}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
