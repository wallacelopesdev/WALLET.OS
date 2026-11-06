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
import { accountFormSchema, accountIdSchema, findDuplicateAccount } from "./schema";

const NOT_FOUND = "Conta não encontrada.";

type Authed = Extract<Awaited<ReturnType<typeof requireUser>>, { ok: true }>;

function parseForm(formData: FormData) {
  const parsed = accountFormSchema.safeParse({
    name: formData.get("name") ?? "",
    institution: formData.get("institution") ?? "",
    kind: formData.get("kind") ?? "",
    openingBalance: formData.get("openingBalance") ?? "",
  });
  if (parsed.success) return { ok: true as const, data: parsed.data };

  const fieldErrors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? "form");
    fieldErrors[key] ??= issue.message;
  }
  return { ok: false as const, fieldErrors };
}

async function duplicateError(
  { supabase }: Authed,
  candidate: { name: string; institution: string | null },
  ignoreId?: string,
): Promise<ActionResult | null> {
  const { data, error } = await supabase
    .from("bank_accounts")
    .select("id,name,institution")
    .eq("archived", false);

  if (error) return { ok: false, error: dbErrorMessage(error, "accounts.duplicate") };

  return findDuplicateAccount(candidate, data, ignoreId)
    ? {
        ok: false,
        error: "Já existe uma conta ativa com esse nome nessa instituição.",
        fieldErrors: { name: "Escolha outro nome." },
      }
    : null;
}

export async function createAccount(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const form = parseForm(formData);
  if (!form.ok) {
    return { ok: false, error: "Revise os campos destacados.", fieldErrors: form.fieldErrors };
  }

  const duplicate = await duplicateError(auth, form.data);
  if (duplicate) return duplicate;

  const { data, error } = await auth.supabase
    .from("bank_accounts")
    .insert({ ...form.data, user_id: auth.user.id })
    .select("id")
    .single();

  if (error) return { ok: false, error: dbErrorMessage(error, "accounts.create") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "account.created",
    entityType: "bank_account",
    entityId: data.id,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Conta criada." };
}

export async function updateAccount(
  accountId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!accountIdSchema.safeParse(accountId).success) {
    return { ok: false, error: NOT_FOUND };
  }

  const form = parseForm(formData);
  if (!form.ok) {
    return { ok: false, error: "Revise os campos destacados.", fieldErrors: form.fieldErrors };
  }

  const duplicate = await duplicateError(auth, form.data, accountId);
  if (duplicate) return duplicate;

  const { data, error } = await auth.supabase
    .from("bank_accounts")
    .update(form.data)
    .eq("id", accountId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: dbErrorMessage(error, "accounts.update") };
  if (!data) return { ok: false, error: NOT_FOUND };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "account.updated",
    entityType: "bank_account",
    entityId: accountId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Conta atualizada." };
}

async function setArchived(accountId: string, archived: boolean): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!accountIdSchema.safeParse(accountId).success) {
    return { ok: false, error: NOT_FOUND };
  }

  const { data, error } = await auth.supabase
    .from("bank_accounts")
    .update({ archived })
    .eq("id", accountId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: dbErrorMessage(error, "accounts.archive") };
  if (!data) return { ok: false, error: NOT_FOUND };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: archived ? "account.archived" : "account.unarchived",
    entityType: "bank_account",
    entityId: accountId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: archived ? "Conta arquivada." : "Conta reativada." };
}

export async function archiveAccount(accountId: string): Promise<ActionResult> {
  return setArchived(accountId, true);
}

export async function unarchiveAccount(accountId: string): Promise<ActionResult> {
  return setArchived(accountId, false);
}

/**
 * Em caso de sucesso redireciona para a lista: a página de detalhe da conta
 * deixa de existir. O banco recusa a exclusão se houver movimentações, mesmo
 * que uma tenha sido criada depois de a tela ser carregada.
 */
export async function deleteAccount(accountId: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!accountIdSchema.safeParse(accountId).success) {
    return { ok: false, error: NOT_FOUND };
  }

  const { data, error } = await auth.supabase
    .from("bank_accounts")
    .delete()
    .eq("id", accountId)
    .select("id")
    .maybeSingle();

  if (error?.code === "23503") {
    return {
      ok: false,
      error: "Esta conta tem movimentações e não pode ser excluída. Arquive-a.",
    };
  }
  if (error) return { ok: false, error: dbErrorMessage(error, "accounts.delete") };
  if (!data) return { ok: false, error: NOT_FOUND };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "account.deleted",
    entityType: "bank_account",
    entityId: accountId,
  });

  revalidatePath("/", "layout");
  redirect("/financeiro?aviso=conta-excluida");
}
