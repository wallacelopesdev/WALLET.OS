import { timingSafeEqual } from "node:crypto";
import { after, NextResponse, type NextRequest } from "next/server";
import { createTokenClient } from "@/features/agent/ingest";
import { createPluggyProvider, pluggyEnv } from "@/features/agent/providers/pluggy";
import { syncAgent } from "@/features/agent/sync";

const HANDLED = new Set(["item/updated", "item/error"]);

function matches(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Aviso opcional da Pluggy. O corpo só diz que algo mudou: os dados são buscados de novo,
 * com as credenciais próprias. A Pluggy exige resposta em até 10 segundos, então o
 * processamento acontece depois da resposta.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.PLUGGY_WEBHOOK_SECRET ?? "";
  const token = process.env.WALLET_SYNC_TOKEN ?? "";
  const env = pluggyEnv();
  if (!secret || !token || !env) return NextResponse.json({ error: "não configurado" }, { status: 404 });

  if (!matches(request.headers.get("x-wallet-webhook-secret") ?? "", secret)) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }

  let event: unknown;
  try {
    event = ((await request.json()) as { event?: unknown }).event;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (typeof event === "string" && HANDLED.has(event)) {
    after(async () => {
      try {
        await syncAgent(createTokenClient(), createPluggyProvider(env), token);
      } catch (error) {
        console.error(`[webhook] ${error instanceof Error ? error.message : "falha"}`);
      }
    });
  }

  return NextResponse.json({ received: true });
}
