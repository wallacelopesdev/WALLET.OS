import { todayInSaoPaulo } from "@/lib/dates";
import { ingestCapture } from "./ingest";
import type { OpenFinanceProvider } from "./providers/types";

type RpcClient = Parameters<typeof ingestCapture>[0];

type ConnectionRow = {
  id: string;
  external_item_id: string;
  status: "active" | "error" | "expired";
  next_retry_at: string | null;
};

type TargetRow = {
  pluggy_account_id: string;
  pluggy_type: "BANK" | "CREDIT";
  account_id: string | null;
  card_id: string | null;
  date_from: string;
  connection_id: string | null;
};

export type SyncSummary = {
  created: number;
  matched: number;
  pending: number;
  duplicate: number;
  ignored: number;
  failed: number;
  connectionsFailed: number;
  skipped?: "paused" | "already_running";
};

const emptySummary = (): SyncSummary => ({
  created: 0,
  matched: 0,
  pending: 0,
  duplicate: 0,
  ignored: 0,
  failed: 0,
  connectionsFailed: 0,
});

function dbFailure(error: { code?: string }): Error {
  return new Error(`Banco respondeu ${error.code ?? "erro"}`);
}

/**
 * Traz as novidades das contas ligadas. Roda com a sessão do usuário (token null) ou com o
 * token do agendador. Uma conexão com problema não interrompe as demais, e uma conta só é
 * marcada como sincronizada se tudo nela deu certo, para tentar de novo depois.
 */
export async function syncAgent(
  client: RpcClient,
  provider: OpenFinanceProvider,
  token: string | null,
  now: Date = new Date(),
): Promise<SyncSummary> {
  const summary = emptySummary();

  const paused = await client.rpc("agent_is_paused", { p_token: token });
  if (paused.error) throw dbFailure(paused.error);
  if (paused.data === true) return { ...summary, skipped: "paused" };

  const run = await client.rpc("agent_start_run", { p_token: token, p_kind: "sync" });
  if (run.error) throw dbFailure(run.error);
  if (!run.data) return { ...summary, skipped: "already_running" };
  const runId = run.data as string;

  let fatal: string | null = null;

  try {
    const [connections, targets] = await Promise.all([
      client.rpc("agent_connections", { p_token: token }),
      client.rpc("pluggy_sync_targets", { p_token: token }),
    ]);
    if (connections.error) throw dbFailure(connections.error);
    if (targets.error) throw dbFailure(targets.error);

    const today = todayInSaoPaulo(now);
    const allTargets = (targets.data ?? []) as TargetRow[];

    for (const connection of (connections.data ?? []) as ConnectionRow[]) {
      if (connection.next_retry_at && new Date(connection.next_retry_at) > now) continue;

      const links = allTargets.filter((t) => t.connection_id === connection.id);
      let failedHere = false;
      let errorCode: string | null = null;

      try {
        const health = await provider.getConnectionHealth(connection.external_item_id);

        await client.rpc("agent_report_connection", {
          p_token: token,
          p_connection: connection.id,
          p_status: health.status,
          p_institution: health.institution,
          p_consent_expires_at: health.consentExpiresAt,
          p_error_code: health.errorCode,
        });

        // Autorização vencida: leituras viriam vazias, e vazio não é "sem movimentos".
        if (health.status !== "active") {
          summary.connectionsFailed += 1;
          continue;
        }

        for (const link of links) {
          const { events, ignored } = await provider.listEvents(
            { id: link.pluggy_account_id, type: link.pluggy_type },
            link.date_from,
            today,
          );
          summary.ignored += ignored;
          let linkFailed = false;

          for (const event of events) {
            const result = await ingestCapture(client, {
              token,
              source: "pluggy",
              externalRef: event.externalRef,
              description: event.description,
              amountCents: event.amountCents,
              date: event.date,
              method: event.method,
              accountId: link.account_id,
              cardId: link.card_id,
              reason: event.reason,
              intent: event.intent,
            });

            if (result.error) {
              console.error(`[sync] falha ao registrar, código ${result.error.code ?? "?"}`);
              summary.failed += 1;
              linkFailed = true;
              continue;
            }
            const status = (result.data as { status?: string } | null)?.status;
            if (status === "created" || status === "matched" || status === "pending" || status === "duplicate") {
              summary[status] += 1;
            }
          }

          if (linkFailed) {
            failedHere = true;
            errorCode = "PROCESSING_FAILED";
          } else {
            await client.rpc("pluggy_mark_synced", {
              p_token: token,
              p_pluggy_account: link.pluggy_account_id,
            });
          }
        }
      } catch (error) {
        console.error(`[sync] ${error instanceof Error ? error.message : "falha"}`);
        failedHere = true;
        errorCode = "PROVIDER_UNAVAILABLE";
      }

      if (failedHere) summary.connectionsFailed += 1;

      await client.rpc("agent_report_connection", {
        p_token: token,
        p_connection: connection.id,
        p_status: failedHere ? "error" : "active",
        p_institution: null,
        p_consent_expires_at: null,
        p_error_code: errorCode,
      });
    }
  } catch (error) {
    fatal = error instanceof Error ? error.message : "falha";
    console.error(`[sync] ${fatal}`);
  }

  const status = fatal
    ? "failed"
    : summary.connectionsFailed > 0 || summary.failed > 0
      ? "partial"
      : "success";

  await client.rpc("agent_finish_run", {
    p_token: token,
    p_run: runId,
    p_status: status,
    p_summary: summary,
    p_error_code: fatal ? "SYNC_FAILED" : null,
  });

  if (fatal) throw new Error(fatal);
  return summary;
}
