import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createTokenClient } from "@/features/agent/ingest";
import { createPluggyProvider, pluggyEnv } from "@/features/agent/providers/pluggy";
import { syncAgent } from "@/features/agent/sync";
import { todayInSaoPaulo } from "@/lib/dates";

function matches(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Rotina diária do agente, disparada pelo agendador da Vercel (vercel.json): sincroniza as
 * conexões e roda as automações. Falha na sincronização não impede as automações.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET ?? "";
  const received = request.headers.get("authorization") ?? "";
  if (!secret || !matches(received, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }

  const token = process.env.WALLET_SYNC_TOKEN ?? "";
  if (!token) {
    return NextResponse.json({ error: "WALLET_SYNC_TOKEN não configurado" }, { status: 503 });
  }

  const client = createTokenClient();
  const env = pluggyEnv();

  let sync: unknown = { skipped: "not_configured" };
  let syncFailed = false;
  if (env) {
    try {
      sync = await syncAgent(client, createPluggyProvider(env), token);
    } catch (error) {
      console.error(`[cron] ${error instanceof Error ? error.message : "falha"}`);
      syncFailed = true;
      sync = { error: "falha na sincronização" };
    }
  }

  const automations = await client.rpc("agent_run_automations", {
    p_token: token,
    p_today: todayInSaoPaulo(),
  });
  if (automations.error) {
    console.error(`[cron] automações, código ${automations.error.code ?? "?"}`);
  }

  const failed = syncFailed || Boolean(automations.error);
  return NextResponse.json(
    { sync, automations: automations.error ? { error: "falha nas automações" } : automations.data },
    { status: failed ? 502 : 200 },
  );
}
