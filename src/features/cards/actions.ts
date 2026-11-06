"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  dbErrorMessage,
  type ActionResult,
  type FieldErrors,
} from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import {
  cardFormSchema,
  idSchema,
  paymentFormSchema,
  purchaseEditSchema,
  purchaseFormSchema,
} from "./schema";

const CARD_NOT_FOUND = "Cartão não encontrado.";
const ENTRY_NOT_FOUND = "Lançamento não encontrado.";
const INVALID_FORM = "Revise os campos destacados.";

type Issues = { path: PropertyKey[]; message: string }[];

function invalid(issues: Issues): ActionResult {
  const fieldErrors: FieldErrors = {};
  for (const issue of issues) {
    fieldErrors[String(issue.path[0] ?? "form")] ??= issue.message;
  }
  return { ok: false, error: INVALID_FORM, fieldErrors };
}

const field = (formData: FormData, name: string) => formData.get(name) ?? "";

function parseCard(formData: FormData) {
  return cardFormSchema.safeParse({
    name: field(formData, "name"),
    institution: field(formData, "institution"),
    last4: field(formData, "last4"),
    limit: field(formData, "limit"),
    closingDay: field(formData, "closingDay"),
    dueDay: field(formData, "dueDay"),
  });
}

export async function createCard(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = parseCard(formData);
  if (!parsed.success) return invalid(parsed.error.issues);

  const { data, error } = await auth.supabase
    .from("credit_cards")
    .insert({ ...parsed.data, user_id: auth.user.id })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbErrorMessage(error, "cards.create") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "card.created",
    entityType: "credit_card",
    entityId: data.id,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Cartão cadastrado." };
}

export async function updateCard(
  cardId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!idSchema.safeParse(cardId).success) return { ok: false, error: CARD_NOT_FOUND };

  const parsed = parseCard(formData);
  if (!parsed.success) return invalid(parsed.error.issues);

  const { data, error } = await auth.supabase
    .from("credit_cards")
    .update(parsed.data)
    .eq("id", cardId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: dbErrorMessage(error, "cards.update") };
  if (!data) return { ok: false, error: CARD_NOT_FOUND };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "card.updated",
    entityType: "credit_card",
    entityId: cardId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Cartão atualizado." };
}

async function setArchived(cardId: string, archived: boolean): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!idSchema.safeParse(cardId).success) return { ok: false, error: CARD_NOT_FOUND };

  const { data, error } = await auth.supabase
    .from("credit_cards")
    .update({ archived })
    .eq("id", cardId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: dbErrorMessage(error, "cards.archive") };
  if (!data) return { ok: false, error: CARD_NOT_FOUND };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: archived ? "card.archived" : "card.unarchived",
    entityType: "credit_card",
    entityId: cardId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: archived ? "Cartão arquivado." : "Cartão reativado." };
}

export async function archiveCard(cardId: string): Promise<ActionResult> {
  return setArchived(cardId, true);
}

export async function unarchiveCard(cardId: string): Promise<ActionResult> {
  return setArchived(cardId, false);
}

/** O banco recusa se houver lançamentos. Em caso de sucesso, redireciona para a lista. */
export async function deleteCard(cardId: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!idSchema.safeParse(cardId).success) return { ok: false, error: CARD_NOT_FOUND };

  const { data, error } = await auth.supabase
    .from("credit_cards")
    .delete()
    .eq("id", cardId)
    .select("id")
    .maybeSingle();

  if (error?.code === "23503") {
    return { ok: false, error: "Este cartão tem lançamentos e não pode ser excluído. Arquive-o." };
  }
  if (error) return { ok: false, error: dbErrorMessage(error, "cards.delete") };
  if (!data) return { ok: false, error: CARD_NOT_FOUND };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "card.deleted",
    entityType: "credit_card",
    entityId: cardId,
  });

  revalidatePath("/", "layout");
  redirect("/cartoes");
}

export async function createPurchase(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = purchaseFormSchema.safeParse({
    requestId: field(formData, "requestId"),
    cardId: field(formData, "cardId"),
    description: field(formData, "description"),
    amount: field(formData, "amount"),
    installments: field(formData, "installments"),
    postedAt: field(formData, "postedAt"),
    categoryId: field(formData, "categoryId"),
    notes: field(formData, "notes"),
  });
  if (!parsed.success) return invalid(parsed.error.issues);

  const input = parsed.data;
  const message = input.installments > 1 ? `Compra registrada em ${input.installments}x.` : "Compra registrada.";

  const { data, error } = await auth.supabase.rpc("create_card_purchase", {
    p_card: input.cardId,
    p_description: input.description,
    p_amount_cents: input.amount,
    p_installments: input.installments,
    p_posted_at: input.postedAt,
    p_category: input.categoryId,
    p_notes: input.notes,
    p_request_id: input.requestId,
  });

  // Dois envios simultâneos da mesma requisição: o outro já gravou.
  if (error?.code === "23505") {
    revalidatePath("/", "layout");
    return { ok: true, message };
  }
  if (error?.code === "P0002") return { ok: false, error: CARD_NOT_FOUND };
  if (error) return { ok: false, error: dbErrorMessage(error, "purchases.create") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "card_purchase.created",
    entityType: "transaction",
    entityId: String(data),
  });

  revalidatePath("/", "layout");
  return { ok: true, message };
}

/** Só descrição e categoria: para mudar o valor, exclua e registre de novo. */
export async function updatePurchase(
  transactionId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!idSchema.safeParse(transactionId).success) return { ok: false, error: ENTRY_NOT_FOUND };

  const parsed = purchaseEditSchema.safeParse({
    description: field(formData, "description"),
    categoryId: field(formData, "categoryId"),
  });
  if (!parsed.success) return invalid(parsed.error.issues);

  const { data: target, error: readError } = await auth.supabase
    .from("transactions")
    .select("id,installment_id")
    .eq("id", transactionId)
    .not("card_id", "is", null)
    .is("account_id", null)
    .maybeSingle();
  if (readError) return { ok: false, error: dbErrorMessage(readError, "purchases.read") };
  if (!target) return { ok: false, error: ENTRY_NOT_FOUND };

  const values = {
    description: parsed.data.description,
    category_id: parsed.data.categoryId,
    category_source: parsed.data.categoryId ? ("manual" as const) : null,
  };
  const update = auth.supabase.from("transactions").update(values);
  const { error } = await (target.installment_id
    ? update.eq("installment_id", target.installment_id)
    : update.eq("id", transactionId));
  if (error) return { ok: false, error: dbErrorMessage(error, "purchases.update") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "card_purchase.updated",
    entityType: "transaction",
    entityId: transactionId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Compra atualizada." };
}

/** Exclui a compra inteira, com todas as parcelas. */
export async function deletePurchase(transactionId: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!idSchema.safeParse(transactionId).success) return { ok: false, error: ENTRY_NOT_FOUND };

  const { error } = await auth.supabase.rpc("delete_card_purchase", {
    p_transaction: transactionId,
  });
  if (error?.code === "P0002") return { ok: false, error: ENTRY_NOT_FOUND };
  if (error) return { ok: false, error: dbErrorMessage(error, "purchases.delete") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "card_purchase.deleted",
    entityType: "transaction",
    entityId: transactionId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Compra excluída." };
}

export async function payInvoice(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = paymentFormSchema.safeParse({
    requestId: field(formData, "requestId"),
    invoiceId: field(formData, "invoiceId"),
    accountId: field(formData, "accountId"),
    amount: field(formData, "amount"),
    paidAt: field(formData, "paidAt"),
  });
  if (!parsed.success) return invalid(parsed.error.issues);

  const input = parsed.data;
  const { error } = await auth.supabase.rpc("pay_invoice", {
    p_invoice: input.invoiceId,
    p_account: input.accountId,
    p_amount_cents: input.amount,
    p_paid_at: input.paidAt,
    p_request_id: input.requestId,
  });

  if (error?.code === "23505") {
    revalidatePath("/", "layout");
    return { ok: true, message: "Pagamento registrado." };
  }
  if (error?.code === "P0002") return { ok: false, error: "Fatura não encontrada." };
  if (error?.code === "WL007") {
    return {
      ok: false,
      error: dbErrorMessage(error, "invoices.pay"),
      fieldErrors: { amount: "Maior que o saldo em aberto." },
    };
  }
  if (error) return { ok: false, error: dbErrorMessage(error, "invoices.pay") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "invoice.paid",
    entityType: "card_invoice",
    entityId: input.invoiceId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Pagamento registrado." };
}

/** Desfaz um pagamento: o saldo da conta volta e a fatura reabre. */
export async function undoPayment(transactionId: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!idSchema.safeParse(transactionId).success) return { ok: false, error: ENTRY_NOT_FOUND };

  const { data, error } = await auth.supabase
    .from("transactions")
    .delete()
    .eq("id", transactionId)
    .eq("kind", "invoice_payment")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: dbErrorMessage(error, "invoices.undo") };
  if (!data) return { ok: false, error: ENTRY_NOT_FOUND };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "invoice.payment_undone",
    entityType: "transaction",
    entityId: transactionId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Pagamento desfeito." };
}
