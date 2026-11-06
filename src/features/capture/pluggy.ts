import { todayInSaoPaulo } from "@/lib/dates";
import { ingestCapture } from "./ingest";
import { mapPluggyTransaction, type PluggyTransaction } from "./pluggy-map";

/**
 * Integração com a Pluggy (Meu Pluggy), somente no servidor. As credenciais vêm de
 * variáveis sem o prefixo NEXT_PUBLIC_ e nunca chegam ao navegador.
 */
type PluggyEnv = { baseUrl: string; clientId: string; clientSecret: string; itemIds: string[] };

export function pluggyEnv(): PluggyEnv | null {
  const clientId = process.env.PLUGGY_CLIENT_ID ?? "";
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET ?? "";
  const itemIds = (process.env.PLUGGY_ITEM_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!clientId || !clientSecret || itemIds.length === 0) return null;
  return {
    baseUrl: process.env.PLUGGY_API_URL || "https://api.pluggy.ai",
    clientId,
    clientSecret,
    itemIds,
  };
}

class PluggyError extends Error {}

async function pluggyFetch<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    // Só o status: a resposta pode trazer dados da conta.
    throw new PluggyError(`Pluggy respondeu ${response.status}`);
  }
  return (await response.json()) as T;
}

async function authenticate(env: PluggyEnv): Promise<string> {
  const { apiKey } = await pluggyFetch<{ apiKey: string }>(`${env.baseUrl}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: env.clientId, clientSecret: env.clientSecret }),
  });
  return apiKey;
}

export type PluggyAccount = {
  id: string;
  type: "BANK" | "CREDIT";
  name: string;
  number: string | null;
};

export async function listPluggyAccounts(env: PluggyEnv): Promise<PluggyAccount[]> {
  const apiKey = await authenticate(env);
  const all: PluggyAccount[] = [];
  for (const itemId of env.itemIds) {
    const { results } = await pluggyFetch<{
      results: { id: string; type: "BANK" | "CREDIT"; name: string; marketingName?: string | null; number?: string | null }[];
    }>(`${env.baseUrl}/accounts?itemId=${encodeURIComponent(itemId)}`, {
      headers: { "X-API-KEY": apiKey },
    });
    for (const account of results) {
      all.push({
        id: account.id,
        type: account.type,
        name: account.marketingName || account.name,
        number: account.number ?? null,
      });
    }
  }
  return all;
}

async function listTransactions(
  env: PluggyEnv,
  apiKey: string,
  accountId: string,
  dateFrom: string,
): Promise<PluggyTransaction[]> {
  const all: PluggyTransaction[] = [];
  const query = new URLSearchParams({ accountId, dateFrom });
  let path: string | null = `/v2/transactions?${query}`;
  // Limite de segurança contra uma paginação que não termine.
  for (let page = 0; path && page < 100; page += 1) {
    const body: { results: PluggyTransaction[]; next: string | null } = await pluggyFetch(
      `${env.baseUrl}${path}`,
      { headers: { "X-API-KEY": apiKey } },
    );
    all.push(...body.results);
    path = body.next ? `/v2/transactions${body.next}` : null;
  }
  return all;
}

type RpcClient = Parameters<typeof ingestCapture>[0];

type SyncTarget = {
  pluggy_account_id: string;
  pluggy_type: "BANK" | "CREDIT";
  account_id: string | null;
  card_id: string | null;
  date_from: string;
};

export type SyncSummary = {
  created: number;
  matched: number;
  pending: number;
  duplicate: number;
  ignored: number;
  failed: number;
};

/**
 * Traz as novidades das contas ligadas. Roda com a sessão do usuário (token null) ou com
 * o token do agendador. Uma falha em um lançamento não interrompe os demais, e a conta
 * só é marcada como sincronizada se tudo nela deu certo, para tentar de novo depois.
 */
export async function syncPluggy(
  client: RpcClient,
  env: PluggyEnv,
  token: string | null,
): Promise<SyncSummary> {
  const summary: SyncSummary = { created: 0, matched: 0, pending: 0, duplicate: 0, ignored: 0, failed: 0 };

  const { data, error } = await client.rpc("pluggy_sync_targets", { p_token: token });
  if (error) throw new PluggyError(`Banco respondeu ${error.code ?? "erro"}`);

  const targets = (data ?? []) as SyncTarget[];
  if (targets.length === 0) return summary;

  const apiKey = await authenticate(env);
  const today = todayInSaoPaulo();

  for (const target of targets) {
    const transactions = await listTransactions(env, apiKey, target.pluggy_account_id, target.date_from);
    let failedHere = false;

    for (const tx of transactions) {
      const mapped = mapPluggyTransaction(tx, target.pluggy_type, today);
      if (!mapped) {
        summary.ignored += 1;
        continue;
      }

      const result = await ingestCapture(client, {
        token,
        source: "pluggy",
        externalRef: mapped.externalRef,
        description: mapped.description,
        amountCents: mapped.amountCents,
        date: mapped.date,
        method: mapped.method,
        accountId: target.account_id,
        cardId: target.card_id,
        reason: mapped.reason,
      });

      if (result.error) {
        console.error(`[pluggy] falha ao registrar lançamento, código ${result.error.code ?? "?"}`);
        summary.failed += 1;
        failedHere = true;
        continue;
      }
      const status = (result.data as { status?: keyof SyncSummary } | null)?.status;
      if (status && status in summary) summary[status] += 1;
    }

    if (!failedHere) {
      await client.rpc("pluggy_mark_synced", {
        p_token: token,
        p_pluggy_account: target.pluggy_account_id,
      });
    }
  }

  return summary;
}
