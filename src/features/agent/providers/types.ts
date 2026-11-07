import type { CaptureIntent } from "./pluggy-map";

export type ProviderAccount = {
  id: string;
  itemId: string;
  type: "BANK" | "CREDIT";
  name: string;
  number: string | null;
};

/** Evento já normalizado: o pipeline não conhece o formato de nenhum provedor. */
export type ProviderEvent = {
  externalRef: string;
  description: string;
  /** Negativo é saída, positivo é entrada. */
  amountCents: number;
  date: string;
  method: "pix" | "debit" | "credit" | "boleto" | "transfer" | null;
  intent: CaptureIntent;
  reason: string | null;
};

export type ConnectionHealth = {
  status: "active" | "error" | "expired";
  institution: string | null;
  consentExpiresAt: string | null;
  errorCode: string | null;
};

/**
 * Tudo que o agente precisa de um provedor de Open Finance. Para adicionar outro (Belvo, por
 * exemplo), implemente esta interface: nada no pipeline muda.
 */
export interface OpenFinanceProvider {
  readonly id: "pluggy";
  listAccounts(itemIds: readonly string[]): Promise<ProviderAccount[]>;
  listEvents(
    account: { id: string; type: "BANK" | "CREDIT" },
    dateFrom: string,
    today: string,
  ): Promise<{ events: ProviderEvent[]; ignored: number }>;
  getConnectionHealth(itemId: string): Promise<ConnectionHealth>;
}
