import { createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "@/lib/env";

/**
 * Cliente para chamadas sem sessão (iPhone e agendador), com a chave pública. Não usa a
 * service role: o banco só aceita a operação se o token informado for válido, e tudo
 * fica restrito ao dono do token.
 */
export function createTokenClient() {
  const { url, anonKey } = supabaseEnv();
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type IngestParams = {
  token: string | null;
  source: "apple_pay" | "notification" | "sms" | "email" | "pluggy" | "ofx" | "csv";
  intent?: "normal" | "invoice_payment" | "refund" | "possible_transfer";
  externalRef?: string | null;
  description: string;
  amountCents: number;
  date: string;
  method?: string | null;
  hint?: string | null;
  last4?: string | null;
  accountId?: string | null;
  cardId?: string | null;
  location?: string | null;
  reason?: string | null;
};

export type IngestResult = { status: "created" | "matched" | "pending" | "duplicate" };

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
};

export async function ingestCapture(client: RpcClient, params: IngestParams) {
  return client.rpc("ingest_capture", {
    p_token: params.token,
    p_source: params.source,
    p_external_ref: params.externalRef ?? null,
    p_description: params.description,
    p_amount_cents: params.amountCents,
    p_date: params.date,
    p_method: params.method ?? null,
    p_hint: params.hint ?? null,
    p_last4: params.last4 ?? null,
    p_account: params.accountId ?? null,
    p_card: params.cardId ?? null,
    p_location: params.location ?? null,
    p_reason: params.reason ?? null,
    p_intent: params.intent ?? "normal",
  });
}
