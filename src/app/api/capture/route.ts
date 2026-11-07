import { NextResponse, type NextRequest } from "next/server";
import { createTokenClient, ingestCapture } from "@/features/agent/ingest";
import { parseBankMessage } from "@/features/agent/parse-message";
import { captureBodySchema, parseCaptureAmount } from "@/features/agent/schema";
import { todayInSaoPaulo } from "@/lib/dates";
import { isSupabaseConfigured } from "@/lib/env";

const MAX_BODY_BYTES = 8 * 1024;

const reply = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Recebe eventos dos Atalhos do iPhone. A autenticação é um token próprio, criado em
 * Configurações, porque o atalho não tem sessão. As respostas não devolvem dados.
 */
export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) return reply({ error: "indisponível" }, 503);

  const token = /^Bearer\s+(\S{20,200})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return reply({ error: "token inválido" }, 401);

  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return reply({ error: "corpo grande demais" }, 413);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return reply({ error: "JSON inválido" }, 400);
  }

  const parsed = captureBodySchema.safeParse(json);
  if (!parsed.success) return reply({ error: "dados inválidos" }, 400);
  const body = parsed.data;

  let amountCents: number;
  let description: string;
  let method: string | null = null;
  let last4: string | null = null;
  let reason: string | null = null;

  if (body.text) {
    const message = parseBankMessage(body.text);
    // Código de segurança, aviso ou texto sem valor: nada é guardado.
    if (!message) {
      const auth = await createTokenClient().rpc("pluggy_sync_targets", { p_token: token });
      return auth.error ? reply({ error: "token inválido" }, 401) : reply({ status: "ignored" });
    }
    amountCents = message.amountCents;
    description = message.description;
    method = message.method;
    last4 = message.last4;
    reason = message.reason;
  } else {
    const cents = parseCaptureAmount(body.amount);
    if (cents === null) return reply({ error: "valor inválido" }, 400);
    amountCents = -cents;
    description = body.merchant ?? "";
  }

  const { data, error } = await ingestCapture(createTokenClient(), {
    token,
    source: body.source,
    description,
    amountCents,
    date: todayInSaoPaulo(),
    method,
    hint: body.card ?? null,
    last4,
    location: body.location ?? null,
    reason,
  });

  if (error?.code === "42501") return reply({ error: "token inválido" }, 401);
  if (error?.code === "WL014") return reply({ error: "muitas requisições" }, 429);
  if (error) {
    console.error(`[capture] erro de banco, código ${error.code ?? "desconhecido"}`);
    return reply({ error: "falha ao registrar" }, 500);
  }

  return reply({ status: (data as { status?: string } | null)?.status ?? "created" });
}
