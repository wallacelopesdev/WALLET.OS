"use server";

import { revalidatePath } from "next/cache";
import {
  dbErrorMessage,
  type ActionResult,
  type FieldErrors,
} from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import {
  toTransactionRow,
  transactionFormSchema,
  transactionIdSchema,
  transferFormSchema,
} from "./schema";

const NOT_FOUND = "Lançamento não encontrado.";
const INVALID_FORM = "Revise os campos destacados.";
const ENTITY = "transaction";

type Issues = { path: PropertyKey[]; message: string }[];

function toFieldErrors(issues: Issues): FieldErrors {
  const fieldErrors: FieldErrors = {};
  for (const issue of issues) {
    fieldErrors[String(issue.path[0] ?? "form")] ??= issue.message;
  }
  return fieldErrors;
}

const field = (formData: FormData, name: string) => formData.get(name) ?? "";

function parseTransaction(formData: FormData) {
  return transactionFormSchema.safeParse({
    requestId: field(formData, "requestId"),
    kind: field(formData, "kind"),
    description: field(formData, "description"),
    amount: field(formData, "amount"),
    accountId: field(formData, "accountId"),
    categoryId: field(formData, "categoryId"),
    postedAt: field(formData, "postedAt"),
    competenceDate: field(formData, "competenceDate"),
    paymentMethod: field(formData, "paymentMethod"),
    notes: field(formData, "notes"),
  });
}

function parseTransfer(formData: FormData) {
  return transferFormSchema.safeParse({
    requestId: field(formData, "requestId"),
    fromAccountId: field(formData, "fromAccountId"),
    toAccountId: field(formData, "toAccountId"),
    amount: field(formData, "amount"),
    postedAt: field(formData, "postedAt"),
    description: field(formData, "description"),
    notes: field(formData, "notes"),
  });
}

export async function createTransaction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = parseTransaction(formData);
  if (!parsed.success) {
    return { ok: false, error: INVALID_FORM, fieldErrors: toFieldErrors(parsed.error.issues) };
  }

  const message = parsed.data.kind === "income" ? "Receita registrada." : "Despesa registrada.";

  const { data, error } = await auth.supabase
    .from("transactions")
    .insert({
      ...toTransactionRow(parsed.data),
      user_id: auth.user.id,
      dedupe_hash: `manual:${parsed.data.requestId}`,
    })
    .select("id")
    .single();

  // Mesma requisição reenviada (clique duplo, nova tentativa): já está gravada.
  if (error?.code === "23505") {
    revalidatePath("/", "layout");
    return { ok: true, message };
  }
  if (error) return { ok: false, error: dbErrorMessage(error, "transactions.create") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "transaction.created",
    entityType: ENTITY,
    entityId: data.id,
  });

  revalidatePath("/", "layout");
  return { ok: true, message };
}

export async function updateTransaction(
  transactionId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!transactionIdSchema.safeParse(transactionId).success) {
    return { ok: false, error: NOT_FOUND };
  }

  const parsed = parseTransaction(formData);
  if (!parsed.success) {
    return { ok: false, error: INVALID_FORM, fieldErrors: toFieldErrors(parsed.error.issues) };
  }

  // Só receitas e despesas são editadas por aqui.
  const { data, error } = await auth.supabase
    .from("transactions")
    .update(toTransactionRow(parsed.data))
    .eq("id", transactionId)
    .in("kind", ["income", "expense"])
    .is("card_id", null)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: dbErrorMessage(error, "transactions.update") };
  if (!data) return { ok: false, error: NOT_FOUND };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "transaction.updated",
    entityType: ENTITY,
    entityId: transactionId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Lançamento atualizado." };
}

export async function createTransfer(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = parseTransfer(formData);
  if (!parsed.success) {
    return { ok: false, error: INVALID_FORM, fieldErrors: toFieldErrors(parsed.error.issues) };
  }

  const message = "Transferência registrada.";
  const input = parsed.data;

  const { data, error } = await auth.supabase.rpc("create_transfer", {
    p_from_account: input.fromAccountId,
    p_to_account: input.toAccountId,
    p_amount_cents: input.amount,
    p_posted_at: input.postedAt,
    p_description: input.description,
    p_notes: input.notes,
    p_request_id: input.requestId,
  });

  // Dois envios simultâneos da mesma requisição: o outro já gravou.
  if (error?.code === "23505") {
    revalidatePath("/", "layout");
    return { ok: true, message };
  }
  if (error) return { ok: false, error: dbErrorMessage(error, "transfers.create") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "transfer.created",
    entityType: "transfer",
    entityId: String(data),
  });

  revalidatePath("/", "layout");
  return { ok: true, message };
}

export async function updateTransfer(
  groupId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!transactionIdSchema.safeParse(groupId).success) {
    return { ok: false, error: NOT_FOUND };
  }

  const parsed = parseTransfer(formData);
  if (!parsed.success) {
    return { ok: false, error: INVALID_FORM, fieldErrors: toFieldErrors(parsed.error.issues) };
  }

  const input = parsed.data;
  const { error } = await auth.supabase.rpc("update_transfer", {
    p_group: groupId,
    p_from_account: input.fromAccountId,
    p_to_account: input.toAccountId,
    p_amount_cents: input.amount,
    p_posted_at: input.postedAt,
    p_description: input.description,
    p_notes: input.notes,
  });

  if (error?.code === "P0002") return { ok: false, error: NOT_FOUND };
  if (error) return { ok: false, error: dbErrorMessage(error, "transfers.update") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "transfer.updated",
    entityType: "transfer",
    entityId: groupId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Transferência atualizada." };
}

/** Exclui o lançamento. Em uma transferência, exclui os dois lados no mesmo comando. */
export async function deleteTransaction(transactionId: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!transactionIdSchema.safeParse(transactionId).success) {
    return { ok: false, error: NOT_FOUND };
  }

  const { data: target, error: readError } = await auth.supabase
    .from("transactions")
    .select("id,transfer_group_id,card_id,account_id,invoice_id")
    .eq("id", transactionId)
    .maybeSingle();

  if (readError) return { ok: false, error: dbErrorMessage(readError, "transactions.read") };
  if (!target) return { ok: false, error: NOT_FOUND };

  // Compra no cartão: sai inteira, com todas as parcelas, pela função do banco.
  if (target.invoice_id && target.card_id && !target.account_id) {
    const { error } = await auth.supabase.rpc("delete_card_purchase", {
      p_transaction: transactionId,
    });
    if (error?.code === "23514") {
      return { ok: false, error: "Esta fatura tem um estorno. Exclua o estorno antes da compra." };
    }
    if (error) return { ok: false, error: dbErrorMessage(error, "purchases.delete") };

    await logAudit(auth.supabase, {
      userId: auth.user.id,
      event: "card_purchase.deleted",
      entityType: ENTITY,
      entityId: transactionId,
    });

    revalidatePath("/", "layout");
    return { ok: true, message: "Compra excluída." };
  }

  const group: string | null = target.transfer_group_id;
  const remove = auth.supabase.from("transactions").delete();
  const { error } = await (group
    ? remove.eq("transfer_group_id", group)
    : remove.eq("id", transactionId));

  if (error) return { ok: false, error: dbErrorMessage(error, "transactions.delete") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: group ? "transfer.deleted" : "transaction.deleted",
    entityType: group ? "transfer" : ENTITY,
    entityId: group ?? transactionId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: group ? "Transferência excluída." : "Lançamento excluído." };
}
