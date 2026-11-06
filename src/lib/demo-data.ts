import type { Account, Movement } from "@/features/accounts/queries";
import { emptyMonthly, isoDate, type Overview } from "@/lib/overview";

export function demoAccounts(): Account[] {
  const createdAt = "2026-01-15T12:00:00.000Z";
  return [
    { id: "demo-corrente", name: "Conta Demo", institution: "Banco Fictício A", kind: "checking", balanceCents: 1247350, openingBalanceCents: 1000000, archived: false, createdAt },
    { id: "demo-poupanca", name: "Reserva Demo", institution: "Banco Fictício B", kind: "savings", balanceCents: 600000, openingBalanceCents: 600000, archived: false, createdAt },
    { id: "demo-carteira", name: "Carteira Demo", institution: null, kind: "wallet", balanceCents: -4500, openingBalanceCents: 0, archived: false, createdAt },
    { id: "demo-antiga", name: "Conta Antiga Demo", institution: "Banco Fictício C", kind: "digital", balanceCents: 0, openingBalanceCents: 0, archived: true, createdAt },
  ];
}

export function demoMovements(accountId: string): Movement[] {
  if (accountId !== "demo-corrente") return [];
  const now = new Date();
  const day = (offset: number) =>
    isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset));
  return [
    { id: "m1", postedAt: day(1), description: "Exemplo de salário", amountCents: 450000, kind: "income", categoryName: null },
    { id: "m2", postedAt: day(3), description: "Exemplo de mercado", amountCents: -32650, kind: "debit", categoryName: "Mercado" },
    { id: "m3", postedAt: day(6), description: "Exemplo de aluguel", amountCents: -170000, kind: "pix_out", categoryName: "Contas fixas" },
  ];
}

/**
 * DADOS FICTÍCIOS — usados apenas no modo demonstração (sem Supabase).
 * Nenhum valor aqui representa dados reais de bancos.
 */
export function demoOverview(): Overview {
  const incomes = [850000, 920000, 880000, 905000, 870000, 940000];
  const expenses = [610000, 655000, 702000, 598000, 640000, 575000];
  const monthly = emptyMonthly().map((m, i) => ({
    ...m,
    incomeCents: incomes[i],
    expenseCents: expenses[i],
  }));

  const now = new Date();
  const due = (days: number) =>
    isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));

  const cards = [
    { id: "d1", name: "Cartão Demo A", institution: "Banco Fictício A", limitCents: 1200000, usedCents: 438000 },
    { id: "d2", name: "Cartão Demo B", institution: "Banco Fictício B", limitCents: 800000, usedCents: 652000 },
  ];

  return {
    isDemo: true,
    hasData: true,
    balanceCents: 1847350,
    incomeCents: monthly[5].incomeCents,
    expenseCents: monthly[5].expenseCents,
    cardSpendCents: 312000,
    openInvoicesCents: cards.reduce((s, c) => s + c.usedCents, 0),
    monthly,
    cards,
    upcoming: [
      { id: "u1", label: "Fatura Cartão Demo B", dueDate: due(4), amountCents: 652000 },
      { id: "u2", label: "Fatura Cartão Demo A", dueDate: due(11), amountCents: 438000 },
      { id: "u3", label: "Internet (exemplo)", dueDate: due(15), amountCents: 12990 },
    ],
  };
}
