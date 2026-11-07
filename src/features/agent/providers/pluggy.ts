import { mapPluggyTransaction, type PluggyTransaction } from "./pluggy-map";
import type { ConnectionHealth, OpenFinanceProvider, ProviderAccount, ProviderEvent } from "./types";

/**
 * Pluggy (Meu Pluggy), somente no servidor. As credenciais vêm de variáveis sem o prefixo
 * NEXT_PUBLIC_ e nunca chegam ao navegador. Nenhuma credencial bancária passa por aqui.
 */
type PluggyEnv = { baseUrl: string; clientId: string; clientSecret: string };

export function pluggyEnv(): PluggyEnv | null {
  const clientId = process.env.PLUGGY_CLIENT_ID ?? "";
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) return null;
  return {
    baseUrl: process.env.PLUGGY_API_URL || "https://api.pluggy.ai",
    clientId,
    clientSecret,
  };
}

/** IDs de conexão informados por variável, importados para a tela na primeira visita. */
export function pluggyItemIdsFromEnv(): string[] {
  return (process.env.PLUGGY_ITEM_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export class ProviderError extends Error {
  constructor(readonly status: number) {
    // Só o status: a resposta pode trazer dados da conta.
    super(`Provedor respondeu ${status}`);
  }
}

type PluggyItem = {
  status?: string | null;
  executionStatus?: string | null;
  consentExpiresAt?: string | null;
  error?: { code?: string | null } | null;
  connector?: { name?: string | null } | null;
};

const AUTHORIZATION_ENDED = new Set([
  "USER_AUTHORIZATION_EXPIRED",
  "USER_AUTHORIZATION_REVOKED",
  "USER_AUTHORIZATION_NOT_GRANTED",
  "INVALID_CREDENTIALS",
  "ACCOUNT_CREDENTIALS_RESET",
]);

/** Traduz o estado da conexão. Atualizando conta como ativa: há dados da última execução. */
export function mapItemHealth(item: PluggyItem): ConnectionHealth {
  const errorCode = item.error?.code ?? (item.executionStatus && /ERROR|INVALID|LOCKED|REVOKED|NOT_GRANTED|NEEDS_ACTION|RESET|NOT_AVAILABLE/.test(item.executionStatus) ? item.executionStatus : null);
  const base = {
    institution: item.connector?.name ?? null,
    consentExpiresAt: item.consentExpiresAt ?? null,
  };

  if (item.status === "LOGIN_ERROR" || (errorCode && AUTHORIZATION_ENDED.has(errorCode))) {
    return { ...base, status: "expired", errorCode: errorCode ?? "LOGIN_ERROR" };
  }
  if (item.status === "OUTDATED" || item.status === "WAITING_USER_INPUT") {
    return { ...base, status: "error", errorCode: errorCode ?? item.status };
  }
  return { ...base, status: "active", errorCode: null };
}

export function createPluggyProvider(env: PluggyEnv): OpenFinanceProvider {
  let apiKey: string | null = null;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${env.baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new ProviderError(response.status);
    return (await response.json()) as T;
  }

  async function authed<T>(path: string): Promise<T> {
    if (!apiKey) {
      const auth = await call<{ apiKey: string }>("/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: env.clientId, clientSecret: env.clientSecret }),
      });
      apiKey = auth.apiKey;
    }
    return call<T>(path, { headers: { "X-API-KEY": apiKey } });
  }

  return {
    id: "pluggy",

    async listAccounts(itemIds) {
      const all: ProviderAccount[] = [];
      for (const itemId of itemIds) {
        const { results } = await authed<{
          results: {
            id: string;
            type: "BANK" | "CREDIT";
            name: string;
            marketingName?: string | null;
            number?: string | null;
          }[];
        }>(`/accounts?itemId=${encodeURIComponent(itemId)}`);
        for (const account of results) {
          all.push({
            id: account.id,
            itemId,
            type: account.type,
            name: account.marketingName || account.name,
            number: account.number ?? null,
          });
        }
      }
      return all;
    },

    async listEvents(account, dateFrom, today) {
      const events: ProviderEvent[] = [];
      let ignored = 0;
      const query = new URLSearchParams({ accountId: account.id, dateFrom });
      let path: string | null = `/v2/transactions?${query}`;
      // Limite de segurança contra uma paginação que não termine.
      for (let page = 0; path && page < 100; page += 1) {
        const body: { results: PluggyTransaction[]; next: string | null } = await authed(path);
        for (const tx of body.results) {
          const event = mapPluggyTransaction(tx, account.type, today);
          if (event) events.push(event);
          else ignored += 1;
        }
        path = body.next ? `/v2/transactions${body.next}` : null;
      }
      return { events, ignored };
    },

    async getConnectionHealth(itemId) {
      try {
        return mapItemHealth(await authed<PluggyItem>(`/items/${encodeURIComponent(itemId)}`));
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) {
          return { status: "error", institution: null, consentExpiresAt: null, errorCode: "ITEM_NOT_FOUND" };
        }
        throw error;
      }
    },
  };
}
