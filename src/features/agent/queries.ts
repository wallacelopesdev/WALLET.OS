import { MigrationRequiredError, isSchemaOutdated } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export type CaptureToken = {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
};

export type PendingEvent = {
  id: string;
  source: string;
  description: string;
  amountCents: number;
  date: string;
  reason: string | null;
  location: string | null;
  intent: "normal" | "invoice_payment" | "refund" | "possible_transfer";
  hasCandidate: boolean;
  accountId: string | null;
};

/** Fatura com saldo em aberto, para ligar um pagamento encontrado no extrato. */
export type OpenInvoice = { id: string; label: string };

export type ProviderLink = {
  pluggyAccountId: string;
  connectionId: string | null;
  accountId: string | null;
  cardId: string | null;
  lastSyncedAt: string | null;
};

export type Connection = {
  id: string;
  externalItemId: string;
  institution: string | null;
  status: "active" | "error" | "expired" | "disconnected";
  consentExpiresAt: string | null;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
};

export type AgentSettings = {
  paused: boolean;
  auto_register: boolean;
  auto_categorize: boolean;
  min_confidence: number;
  automations: {
    recurring: boolean;
    anomalies: boolean;
    duplicates: boolean;
    deadlines: boolean;
    digests: boolean;
  };
};

export type AgentRun = {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
};

export type AgentNotification = {
  id: string;
  title: string;
  body: string | null;
  severity: "info" | "warning" | "critical";
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
};

export type ActivityItem = {
  id: number;
  event: string;
  createdAt: string;
  description: string | null;
  amountCents: number | null;
  reason: string | null;
};

export type RecurringCharge = {
  id: string;
  description: string;
  amountCents: number;
  period: "monthly" | "weekly";
  nextDate: string;
  occurrences: number;
};

export type CategoryRule = {
  id: string;
  pattern: string;
  categoryId: string;
};

export const DEFAULT_SETTINGS: AgentSettings = {
  paused: false,
  auto_register: true,
  auto_categorize: true,
  min_confidence: 70,
  automations: { recurring: true, anomalies: true, duplicates: true, deadlines: true, digests: true },
};

type Failure = { code?: string } | null | undefined;

function ensure(error: Failure, context: string) {
  if (!error) return;
  if (isSchemaOutdated(error)) throw new MigrationRequiredError();
  console.error(`[${context}] erro de banco, código ${error.code ?? "desconhecido"}`);
  throw new Error("Falha ao carregar os dados.");
}

export async function getSettings(): Promise<AgentSettings> {
  if (!isSupabaseConfigured()) return DEFAULT_SETTINGS;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("agent_settings")
    .select("paused,auto_register,auto_categorize,min_confidence,automations")
    .maybeSingle();
  ensure(error, "agent.settings");
  if (!data) return DEFAULT_SETTINGS;
  return {
    ...DEFAULT_SETTINGS,
    ...data,
    automations: { ...DEFAULT_SETTINGS.automations, ...(data.automations as object) },
  };
}

export async function listPending(): Promise<PendingEvent[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("capture_events")
    .select("id,source,description,amount_cents,event_date,reason,location,intent,candidate_transaction_id,account_id")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(100);
  ensure(error, "agent.pending");
  return (data ?? []).map((e) => ({
    id: e.id,
    source: e.source,
    description: e.description,
    amountCents: Number(e.amount_cents),
    date: e.event_date,
    reason: e.reason,
    location: e.location,
    intent: e.intent ?? "normal",
    hasCandidate: Boolean(e.candidate_transaction_id),
    accountId: e.account_id,
  }));
}

/** Quantos eventos aguardam revisão. Sem a migration, simplesmente nenhum. */
export async function countPendingCaptures(): Promise<number> {
  if (!isSupabaseConfigured()) return 0;
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("capture_events")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  return error ? 0 : (count ?? 0);
}

export async function listTokens(): Promise<CaptureToken[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("capture_tokens")
    .select("id,name,last_used_at,created_at")
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  ensure(error, "agent.tokens");
  return (data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    lastUsedAt: t.last_used_at,
    createdAt: t.created_at,
  }));
}

export async function listConnections(): Promise<{ connections: Connection[]; links: ProviderLink[] }> {
  const supabase = await createClient();
  const [connections, links] = await Promise.all([
    supabase
      .from("provider_connections")
      .select("id,external_item_id,institution_name,status,consent_expires_at,last_sync_at,last_error_code")
      .neq("status", "disconnected")
      .order("created_at"),
    supabase.from("pluggy_links").select("pluggy_account_id,connection_id,account_id,card_id,last_synced_at"),
  ]);
  ensure(connections.error, "agent.connections");
  ensure(links.error, "agent.links");
  return {
    connections: (connections.data ?? []).map((c) => ({
      id: c.id,
      externalItemId: c.external_item_id,
      institution: c.institution_name,
      status: c.status,
      consentExpiresAt: c.consent_expires_at,
      lastSyncAt: c.last_sync_at,
      lastErrorCode: c.last_error_code,
    })),
    links: (links.data ?? []).map((l) => ({
      pluggyAccountId: l.pluggy_account_id,
      connectionId: l.connection_id,
      accountId: l.account_id,
      cardId: l.card_id,
      lastSyncedAt: l.last_synced_at,
    })),
  };
}

export async function listNotifications(limit = 20): Promise<AgentNotification[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("id,title,body,severity,action_url,read_at,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  ensure(error, "agent.notifications");
  return (data ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    severity: n.severity,
    actionUrl: n.action_url,
    readAt: n.read_at,
    createdAt: n.created_at,
  }));
}

export async function listActivity(limit = 50): Promise<ActivityItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id,event,created_at,metadata")
    .like("event", "agent.%")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  ensure(error, "agent.activity");
  return (data ?? []).map((row) => {
    const metadata = (row.metadata ?? {}) as { description?: string; amount_cents?: number; reason?: string };
    return {
      id: row.id,
      event: row.event,
      createdAt: row.created_at,
      description: metadata.description ?? null,
      amountCents: typeof metadata.amount_cents === "number" ? metadata.amount_cents : null,
      reason: metadata.reason ?? null,
    };
  });
}

export async function listRecurring(): Promise<RecurringCharge[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("recurring_charges")
    .select("id,description,amount_cents,period,next_date,occurrences")
    .eq("dismissed", false)
    .order("next_date");
  ensure(error, "agent.recurring");
  return (data ?? []).map((r) => ({
    id: r.id,
    description: r.description,
    amountCents: Number(r.amount_cents),
    period: r.period,
    nextDate: r.next_date,
    occurrences: r.occurrences,
  }));
}

export async function listRules(): Promise<CategoryRule[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("category_rules")
    .select("id,pattern,category_id")
    .order("created_at", { ascending: false });
  ensure(error, "agent.rules");
  return (data ?? []).map((r) => ({ id: r.id, pattern: r.pattern, categoryId: r.category_id }));
}

export async function getAgentOverview() {
  const supabase = await createClient();
  const [settings, connectionData, pending, processed, runs, notifications, activity, recurring] = await Promise.all([
    getSettings(),
    listConnections(),
    countPendingCaptures(),
    supabase
      .from("capture_events")
      .select("id", { count: "exact", head: true })
      .in("status", ["created", "matched", "resolved"]),
    supabase
      .from("agent_runs")
      .select("id,kind,status,started_at,finished_at,error_code")
      .order("started_at", { ascending: false })
      .limit(5),
    listNotifications(5),
    listActivity(8),
    listRecurring(),
  ]);
  ensure(processed.error, "agent.processed");
  ensure(runs.error, "agent.runs");

  const lastRuns: AgentRun[] = (runs.data ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    errorCode: r.error_code,
  }));

  return {
    settings,
    ...connectionData,
    pending,
    processed: processed.count ?? 0,
    lastRuns,
    notifications,
    activity,
    recurring,
  };
}
