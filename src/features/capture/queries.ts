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
};

export type PluggyLink = {
  pluggyAccountId: string;
  accountId: string | null;
  cardId: string | null;
  lastSyncedAt: string | null;
};

export type CaptureData = {
  tokens: CaptureToken[];
  pending: PendingEvent[];
  links: PluggyLink[];
  recentCount: number;
};

export async function getCaptureData(): Promise<CaptureData> {
  if (!isSupabaseConfigured()) {
    return { tokens: [], pending: [], links: [], recentCount: 0 };
  }

  const supabase = await createClient();
  const [tokens, pending, links, recent] = await Promise.all([
    supabase
      .from("capture_tokens")
      .select("id,name,last_used_at,created_at")
      .is("revoked_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("capture_events")
      .select("id,source,description,amount_cents,event_date,reason,location")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("pluggy_links").select("pluggy_account_id,account_id,card_id,last_synced_at"),
    supabase
      .from("capture_events")
      .select("id", { count: "exact", head: true })
      .in("status", ["created", "matched"]),
  ]);

  const failed = [tokens, pending, links, recent].find((r) => r.error);
  if (failed?.error) {
    if (isSchemaOutdated(failed.error)) throw new MigrationRequiredError();
    console.error(`[capture] erro de banco, código ${failed.error.code ?? "desconhecido"}`);
    throw new Error("Falha ao carregar os dados.");
  }

  return {
    tokens: (tokens.data ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      lastUsedAt: t.last_used_at,
      createdAt: t.created_at,
    })),
    pending: (pending.data ?? []).map((e) => ({
      id: e.id,
      source: e.source,
      description: e.description,
      amountCents: Number(e.amount_cents),
      date: e.event_date,
      reason: e.reason,
      location: e.location,
    })),
    links: (links.data ?? []).map((l) => ({
      pluggyAccountId: l.pluggy_account_id,
      accountId: l.account_id,
      cardId: l.card_id,
      lastSyncedAt: l.last_synced_at,
    })),
    recentCount: recent.count ?? 0,
  };
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
