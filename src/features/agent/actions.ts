"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dbErrorMessage, type ActionResult } from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { createPluggyProvider, pluggyEnv, pluggyItemIdsFromEnv } from "./providers/pluggy";
import type { ProviderAccount } from "./providers/types";
import { parseTarget, tokenNameSchema, uuidSchema } from "./schema";
import { syncAgent } from "./sync";

const refresh = () => revalidatePath("/", "layout");

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
    return { ok: false, error: "Revise o nome.", fieldErrors: { name: name.error.issues[0].message } };
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

  refresh();
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

  refresh();
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

  refresh();
  return { ok: true, message: "Lançamento registrado." };
}

const REVIEW_ACTIONS = {
  same: { rpc: "confirm_capture_match", message: "Reconhecido como o mesmo lançamento." },
  transfer: { rpc: "link_own_transfer", message: "Registrado como transferência entre suas contas." },
} as const;

/** "É o mesmo lançamento" ou "é transferência entre minhas contas". Só organiza registros. */
export async function reviewPendingCapture(
  eventId: string,
  decision: keyof typeof REVIEW_ACTIONS,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  const action = REVIEW_ACTIONS[decision];
  if (!action || !uuidSchema.safeParse(eventId).success) return { ok: false, error: "Item não encontrado." };

  const { error } = await auth.supabase.rpc(action.rpc, { p_event: eventId });
  if (error?.code === "P0002") return { ok: false, error: "Item não encontrado." };
  if (error) return { ok: false, error: dbErrorMessage(error, "capture.review") };

  refresh();
  return { ok: true, message: action.message };
}

/** Liga um pagamento encontrado no extrato à fatura. O pagamento já aconteceu no banco. */
export async function resolvePendingInvoice(eventId: string, invoiceId: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!uuidSchema.safeParse(eventId).success || !uuidSchema.safeParse(invoiceId).success) {
    return { ok: false, error: "Escolha a fatura." };
  }

  const { error } = await auth.supabase.rpc("resolve_capture_invoice", {
    p_event: eventId,
    p_invoice: invoiceId,
  });
  if (error?.code === "P0002") return { ok: false, error: "Item não encontrado." };
  if (error) return { ok: false, error: dbErrorMessage(error, "capture.invoice") };

  refresh();
  return { ok: true, message: "Pagamento ligado à fatura." };
}

export async function discardPendingCapture(eventId: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!uuidSchema.safeParse(eventId).success) return { ok: false, error: "Item não encontrado." };

  const { error } = await auth.supabase.rpc("discard_capture", { p_event: eventId });
  if (error?.code === "P0002") return { ok: false, error: "Item não encontrado." };
  if (error) return { ok: false, error: dbErrorMessage(error, "capture.discard") };

  refresh();
  return { ok: true, message: "Item descartado." };
}

const itemIdSchema = z.string().trim().min(8, "Informe o ID da conexão.").max(100, "ID inválido.");

export async function addConnection(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const item = itemIdSchema.safeParse(formData.get("itemId") ?? "");
  if (!item.success) {
    return { ok: false, error: "Revise o ID.", fieldErrors: { itemId: item.error.issues[0].message } };
  }

  const { error } = await auth.supabase.rpc("connect_provider", {
    p_provider: "pluggy",
    p_item: item.data,
    p_institution: null,
  });
  if (error) return { ok: false, error: dbErrorMessage(error, "connections.add") };

  refresh();
  return { ok: true, message: "Conexão adicionada." };
}

export async function disconnectConnection(connectionId: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!uuidSchema.safeParse(connectionId).success) return { ok: false, error: "Conexão não encontrada." };

  const { error } = await auth.supabase.rpc("disconnect_provider", { p_connection: connectionId });
  if (error?.code === "P0002") return { ok: false, error: "Conexão não encontrada." };
  if (error) return { ok: false, error: dbErrorMessage(error, "connections.remove") };

  refresh();
  return { ok: true, message: "Conexão removida. Os lançamentos já registrados continuam." };
}

/** Lista as contas das conexões ativas. IDs da variável de ambiente entram como conexões. */
export async function loadProviderAccounts(): Promise<
  { ok: true; accounts: ProviderAccount[] } | { ok: false; error: string }
> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const env = pluggyEnv();
  if (!env) return { ok: false, error: "A Pluggy ainda não foi configurada no servidor." };

  for (const item of pluggyItemIdsFromEnv()) {
    const { error } = await auth.supabase.rpc("connect_provider", {
      p_provider: "pluggy",
      p_item: item,
      p_institution: null,
    });
    if (error) return { ok: false, error: dbErrorMessage(error, "connections.env") };
  }

  const { data, error } = await auth.supabase
    .from("provider_connections")
    .select("external_item_id")
    .neq("status", "disconnected");
  if (error) return { ok: false, error: dbErrorMessage(error, "connections.read") };

  try {
    const accounts = await createPluggyProvider(env).listAccounts(data.map((c) => c.external_item_id));
    refresh();
    return { ok: true, accounts };
  } catch (failure) {
    console.error(`[pluggy] ${failure instanceof Error ? failure.message : "falha"}`);
    return { ok: false, error: "Não foi possível falar com a Pluggy. Confira as credenciais." };
  }
}

/** Liga ou desliga uma conta do banco. Só o que acontecer depois do vínculo entra. */
export async function saveProviderLink(account: ProviderAccount, target: string): Promise<ActionResult> {
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
      return { ok: false, error: account.type === "CREDIT" ? "Ligue a um cartão." : "Ligue a uma conta." };
    }

    const { data: connection, error: readError } = await auth.supabase
      .from("provider_connections")
      .select("id")
      .eq("external_item_id", account.itemId)
      .maybeSingle();
    if (readError) return { ok: false, error: dbErrorMessage(readError, "connections.read") };
    if (!connection) return { ok: false, error: "Conexão não encontrada." };

    const { error } = await auth.supabase.from("pluggy_links").insert({
      user_id: auth.user.id,
      pluggy_account_id: account.id,
      pluggy_type: account.type,
      label: account.name.slice(0, 120),
      account_id: destination.account,
      card_id: destination.card,
      connection_id: connection.id,
    });
    if (error) return { ok: false, error: dbErrorMessage(error, "pluggy.link") };
  }

  refresh();
  return { ok: true, message: target ? "Conta ligada." : "Conta desligada." };
}

export async function syncNow(): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const env = pluggyEnv();
  if (!env) return { ok: false, error: "A Pluggy ainda não foi configurada no servidor." };

  try {
    const s = await syncAgent(auth.supabase, createPluggyProvider(env), null);
    refresh();
    if (s.skipped === "paused") return { ok: false, error: "O agente está pausado." };
    if (s.skipped === "already_running") return { ok: false, error: "Já há uma sincronização em andamento." };
    if (s.connectionsFailed > 0 || s.failed > 0) {
      return { ok: false, error: "Não foi possível sincronizar tudo. Veja o estado das conexões." };
    }
    return {
      ok: true,
      message: `Sincronizado: ${s.created} novos, ${s.matched} já existentes, ${s.pending} para revisar.`,
    };
  } catch (failure) {
    console.error(`[sync] ${failure instanceof Error ? failure.message : "falha"}`);
    return { ok: false, error: "Não foi possível sincronizar. Confira as credenciais da Pluggy." };
  }
}

const settingsSchema = z.object({
  paused: z.boolean(),
  auto_register: z.boolean(),
  auto_categorize: z.boolean(),
  min_confidence: z.number().int().min(50).max(100),
  automations: z.object({
    recurring: z.boolean(),
    anomalies: z.boolean(),
    duplicates: z.boolean(),
    deadlines: z.boolean(),
    digests: z.boolean(),
  }),
});

export async function saveAgentSettings(input: unknown): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Configuração inválida." };

  const { error } = await auth.supabase
    .from("agent_settings")
    .upsert({ user_id: auth.user.id, ...parsed.data });
  if (error) return { ok: false, error: dbErrorMessage(error, "agent.settings") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: parsed.data.paused ? "agent.paused" : "agent.settings_updated",
    entityType: "agent_settings",
    entityId: auth.user.id,
  });

  refresh();
  return { ok: true, message: parsed.data.paused ? "Agente pausado." : "Configurações salvas." };
}

export async function dismissRecurring(id: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!uuidSchema.safeParse(id).success) return { ok: false, error: "Item não encontrado." };

  const { error } = await auth.supabase.from("recurring_charges").update({ dismissed: true }).eq("id", id);
  if (error) return { ok: false, error: dbErrorMessage(error, "recurring.dismiss") };

  refresh();
  return { ok: true, message: "Cobrança dispensada." };
}

export async function markNotificationsRead(): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const { error } = await auth.supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);
  if (error) return { ok: false, error: dbErrorMessage(error, "notifications.read") };

  refresh();
  return { ok: true, message: "Alertas marcados como lidos." };
}

export async function removeCategoryRule(id: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!uuidSchema.safeParse(id).success) return { ok: false, error: "Regra não encontrada." };

  const { error } = await auth.supabase.from("category_rules").delete().eq("id", id);
  if (error) return { ok: false, error: dbErrorMessage(error, "rules.remove") };

  refresh();
  return { ok: true, message: "Regra removida." };
}
