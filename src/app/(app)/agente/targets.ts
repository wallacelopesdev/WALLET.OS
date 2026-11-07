import type { TargetOption } from "@/features/agent/components/pending-panel";
import type { Account } from "@/features/accounts/queries";
import type { CardSummary } from "@/features/cards/queries";

/** Destinos possíveis de um lançamento capturado: contas e cartões ativos. */
export function toTargets(accounts: Account[], cards: CardSummary[]): TargetOption[] {
  return [
    ...accounts
      .filter((a) => !a.archived)
      .map((a) => ({
        value: `account:${a.id}`,
        label: a.institution ? `${a.name} · ${a.institution}` : a.name,
        kind: "account" as const,
      })),
    ...cards
      .filter((c) => !c.archived)
      .map((c) => ({ value: `card:${c.id}`, label: `Cartão ${c.name}`, kind: "card" as const })),
  ];
}
