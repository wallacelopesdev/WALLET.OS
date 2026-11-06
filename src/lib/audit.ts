import type { createClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createClient>>;

type AuditEntry = {
  userId: string;
  event: string;
  entityType: string;
  entityId: string;
};

/**
 * Registra uma operação em audit_logs. Uma falha aqui não desfaz a operação
 * já concluída, então é apenas relatada no log do servidor.
 */
export async function logAudit(supabase: Client, entry: AuditEntry): Promise<void> {
  const { error } = await supabase.from("audit_logs").insert({
    user_id: entry.userId,
    event: entry.event,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
  });
  if (error) {
    console.error(`[audit] falha ao registrar ${entry.event}, código ${error.code}`);
  }
}
