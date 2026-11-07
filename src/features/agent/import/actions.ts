"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dbErrorMessage } from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { isValidISODate, todayInSaoPaulo } from "@/lib/dates";
import { ingestCapture } from "../ingest";
import { inferBankDetails } from "../providers/pluggy-map";
import { parseTarget } from "../schema";
import { parseStatement } from "./parse";
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from "./types";

export type PreviewRow = {
  ref: string;
  date: string;
  description: string;
  amountCents: number;
  alreadyImported: boolean;
};

export type PreviewResult =
  | { ok: true; format: "ofx" | "csv"; fileName: string; rows: PreviewRow[]; skipped: number }
  | { ok: false; error: string };

const prefixedRef = (target: string, ref: string) => `import:${target}:${ref}`;

/** Lê o arquivo em memória e não o guarda. Nada é gravado nesta etapa. */
export async function previewStatement(formData: FormData): Promise<PreviewResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const file = formData.get("file");
  const target = String(formData.get("target") ?? "");
  if (!(file instanceof File)) return { ok: false, error: "Selecione um arquivo." };
  if (!parseTarget(target)) return { ok: false, error: "Escolha a conta ou o cartão do extrato." };
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, error: "O arquivo tem mais de 4 MB." };

  const parsed = parseStatement(file.name, new Uint8Array(await file.arrayBuffer()));
  if (!parsed.ok) return parsed;

  const known = new Set<string>();
  const refs = parsed.rows.map((row) => prefixedRef(target, row.ref));
  for (let i = 0; i < refs.length; i += 100) {
    const { data, error } = await auth.supabase
      .from("capture_events")
      .select("external_ref")
      .in("external_ref", refs.slice(i, i + 100));
    if (error) return { ok: false, error: dbErrorMessage(error, "import.preview") };
    for (const row of data) if (row.external_ref) known.add(row.external_ref);
  }

  return {
    ok: true,
    format: parsed.format,
    fileName: file.name.slice(0, 200),
    skipped: parsed.skipped,
    rows: parsed.rows.map((row) => ({
      ...row,
      alreadyImported: known.has(prefixedRef(target, row.ref)),
    })),
  };
}

const startSchema = z.object({
  format: z.enum(["ofx", "csv"]),
  fileName: z.string().max(200),
  target: z.string(),
  total: z.number().int().min(1).max(MAX_IMPORT_ROWS),
});

export async function startImport(
  input: unknown,
): Promise<{ ok: true; batchId: string } | { ok: false; error: string }> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = startSchema.safeParse(input);
  const destination = parsed.success ? parseTarget(parsed.data.target) : null;
  if (!parsed.success || !destination) return { ok: false, error: "Importação inválida." };

  const { data, error } = await auth.supabase
    .from("import_batches")
    .insert({
      user_id: auth.user.id,
      account_id: destination.account,
      card_id: destination.card,
      source_name: parsed.data.format.toUpperCase(),
      file_name: parsed.data.fileName,
      format: parsed.data.format,
      status: "processing",
      rows_total: parsed.data.total,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbErrorMessage(error, "import.start") };

  return { ok: true, batchId: data.id };
}

const rowSchema = z.object({
  ref: z.string().min(1).max(400),
  date: z.string().refine(isValidISODate),
  description: z.string().trim().min(1).max(200),
  amountCents: z.number().int().refine((v) => v !== 0 && Math.abs(v) <= 100_000_000_000_000),
  categoryId: z.string().uuid().nullable(),
});

const chunkSchema = z.object({
  batchId: z.string().uuid(),
  format: z.enum(["ofx", "csv"]),
  target: z.string(),
  rows: z.array(rowSchema).min(1).max(100),
});

export type ChunkResult =
  | { ok: true; inserted: number; duplicated: number; pending: number; failed: number }
  | { ok: false; error: string };

/**
 * Importa um lote pequeno por vez: a plataforma limita a duração de cada chamada, e uma
 * queda no meio deixa um resultado parcial claro, que pode ser retomado sem duplicar.
 */
export async function importChunk(input: unknown): Promise<ChunkResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = chunkSchema.safeParse(input);
  const destination = parsed.success ? parseTarget(parsed.data.target) : null;
  if (!parsed.success || !destination) return { ok: false, error: "Dados inválidos na importação." };

  const today = todayInSaoPaulo();
  const summary = { inserted: 0, duplicated: 0, pending: 0, failed: 0 };

  for (const row of parsed.data.rows) {
    // Em conta, data futura é agendamento: ainda não aconteceu.
    if (destination.account && row.date > today) {
      summary.failed += 1;
      continue;
    }

    const details = inferBankDetails(row.description, row.amountCents > 0);
    const { data, error } = await ingestCapture(auth.supabase, {
      token: null,
      source: parsed.data.format,
      externalRef: prefixedRef(parsed.data.target, row.ref),
      description: row.description,
      amountCents: row.amountCents,
      date: row.date,
      method: destination.card ? "credit" : details.method,
      intent: destination.card ? "normal" : details.intent,
      accountId: destination.account,
      cardId: destination.card,
    });

    if (error) {
      console.error(`[import] erro de banco, código ${error.code ?? "desconhecido"}`);
      summary.failed += 1;
      continue;
    }

    const result = data as { status?: string; transaction_id?: string } | null;
    if (result?.status === "duplicate" || result?.status === "matched") summary.duplicated += 1;
    else if (result?.status === "pending") summary.pending += 1;
    else summary.inserted += 1;

    if (result?.status === "created" && result.transaction_id) {
      const values: Record<string, unknown> = { batch_id: parsed.data.batchId };
      if (row.categoryId) {
        values.category_id = row.categoryId;
        values.category_source = "manual";
      }
      const update = await auth.supabase.from("transactions").update(values).eq("id", result.transaction_id);
      if (update.error) console.error(`[import] categoria, código ${update.error.code ?? "?"}`);
    }
  }

  return { ok: true, ...summary };
}

const finishSchema = z.object({
  batchId: z.string().uuid(),
  inserted: z.number().int().min(0),
  duplicated: z.number().int().min(0),
  pending: z.number().int().min(0),
  failed: z.number().int().min(0),
});

export async function finishImport(input: unknown): Promise<void> {
  const auth = await requireUser();
  if (!auth.ok) return;

  const parsed = finishSchema.safeParse(input);
  if (!parsed.success) return;
  const { batchId, inserted, duplicated, pending, failed } = parsed.data;

  await auth.supabase
    .from("import_batches")
    .update({
      status: failed > 0 ? "failed" : "completed",
      rows_inserted: inserted,
      rows_duplicated: duplicated,
      error: failed > 0 ? `${failed} linhas não foram importadas; ${pending} aguardam revisão` : null,
    })
    .eq("id", batchId);

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "agent.import_finished",
    entityType: "import_batch",
    entityId: batchId,
  });

  revalidatePath("/", "layout");
}
