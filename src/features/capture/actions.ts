"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { dbErrorMessage, type ActionResult } from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { listPluggyAccounts, pluggyEnv, syncPluggy, type PluggyAccount } from "./pluggy";
import { parseTarget, tokenNameSchema, uuidSchema } from "./schema";

const PAGE = "/configuracoes/captura";

export type TokenResult = ActionResult & { token?: string };

/** O token só existe nesta resposta: no banco fica apenas o hash. */
export async function createCaptureToken(
  _prev: TokenResult | null,
  formData: FormData,
): Promise<TokenResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const name = tokenNameSchema.safeParse(formData.get("name") ?? "");
  if (!name.success) {
    return {
      ok: false,
      error: "Revise o nome.",
      fieldErrors: { name: name.error.issues[0].message },
    };
  }

  const token = `wos_${randomBytes(32).toString("base64url")}`;
  const { data, error } = await auth.supabase
    .from("capture_tokens")
    .insert({
      user_id: auth.user.id,
      name: name.data,
      token_hash: createHash("sha256").update(token).digest("hex"),
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbErrorMessage(error, "capture.token") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "capture_token.created",
    entityType: "capture_token",
    entityId: data.id,
  });

  revalidatePath(PAGE);
  return { ok: true, message: "Token criado.", token };
}

export async function revokeCaptureToken(tokenId: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!uuidSchema.safeParse(tokenId).success) return { ok: false, error: "Token não encontrado." };

  const { data, error } = await auth.supabase
    .from("capture_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: dbErrorMessage(error, "capture.revoke") };
  if (!data) return { ok: false, error: "Token não encontrado." };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "capture_token.revoked",
    entityType: "capture_token",
    entityId: tokenId,
  });

  revalidatePath(PAGE);
  return { ok: true, message: "Token revogado. O atalho que o usava para de funcionar." };
}

export async function resolvePendingCapture(eventId: string, target: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const destination = parseTarget(target);
  if (!uuidSchema.safeParse(eventId).success || !destination) {
    return { ok: false, error: "Escolha a conta ou o cartão." };
  }

  const { error } = await auth.supabase.rpc("resolve_capture", {
    p_event: eventId,
    p_account: destination.account,
    p_card: destination.card,
  });
  if (error?.code === "P0002") return { ok: false, error: "Item não encontrado." };
  if (error) return { ok: false, error: dbErrorMessage(error, "capture.resolve") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "capture.resolved",
    entityType: "capture_event",
    entityId: eventId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Lançamento registrado." };
}

export async function discardPendingCapture(eventId: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!uuidSchema.safeParse(eventId).success) return { ok: false, error: "Item não encontrado." };

  const { error } = await auth.supabase.rpc("discard_capture", { p_event: eventId });
  if (error?.code === "P0002") return { ok: false, error: "Item não encontrado." };
  if (error) return { ok: false, error: dbErrorMessage(error, "capture.discard") };

  revalidatePath("/", "layout");
  return { ok: true, message: "Item descartado." };
}

export async function loadPluggyAccounts(): Promise<
  { ok: true; accounts: PluggyAccount[] } | { ok: false; error: string }
> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const env = pluggyEnv();
  if (!env) return { ok: false, error: "A Pluggy ainda não foi configurada no servidor." };

  try {
    return { ok: true, accounts: await listPluggyAccounts(env) };
  } catch (error) {
    console.error(`[pluggy] ${error instanceof Error ? error.message : "falha"}`);
    return { ok: false, error: "Não foi possível falar com a Pluggy. Confira as credenciais." };
  }
}

/** Liga ou desliga uma conta da Pluggy. Só o que acontecer depois do vínculo entra. */
export async function savePluggyLink(
  account: { id: string; type: "BANK" | "CREDIT"; name: string },
  target: string,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!account.id || account.id.length > 100 || !["BANK", "CREDIT"].includes(account.type)) {
    return { ok: false, error: "Conta inválida." };
  }

  const remove = await auth.supabase.from("pluggy_links").delete().eq("pluggy_account_id", account.id);
  if (remove.error) return { ok: false, error: dbErrorMessage(remove.error, "pluggy.unlink") };

  if (target) {
    const destination = parseTarget(target);
    if (!destination) return { ok: false, error: "Escolha a conta ou o cartão." };
    if ((account.type === "CREDIT") !== Boolean(destination.card)) {
      return {
        ok: false,
        error: account.type === "CREDIT" ? "Ligue a um cartão." : "Ligue a uma conta.",
      };
    }

    const { error } = await auth.supabase.from("pluggy_links").insert({
      user_id: auth.user.id,
      pluggy_account_id: account.id,
      pluggy_type: account.type,
      label: account.name.slice(0, 120),
      account_id: destination.account,
      card_id: destination.card,
    });
    if (error) return { ok: false, error: dbErrorMessage(error, "pluggy.link") };
  }

  revalidatePath(PAGE);
  return { ok: true, message: target ? "Conta ligada." : "Conta desligada." };
}

export async function syncPluggyNow(): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const env = pluggyEnv();
  if (!env) return { ok: false, error: "A Pluggy ainda não foi configurada no servidor." };

  try {
    const s = await syncPluggy(auth.supabase, env, null);
    revalidatePath("/", "layout");
    if (s.failed > 0) {
      return { ok: false, error: `${s.failed} lançamentos falharam. Tente de novo em instantes.` };
    }
    return {
      ok: true,
      message: `Sincronizado: ${s.created} novos, ${s.matched} já existentes, ${s.pending} para revisar.`,
    };
  } catch (error) {
    console.error(`[pluggy] ${error instanceof Error ? error.message : "falha"}`);
    return { ok: false, error: "Não foi possível sincronizar. Confira as credenciais da Pluggy." };
  }
}
