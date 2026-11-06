import type { Account, Movement } from "@/features/accounts/queries";
import type { Card, Invoice, InvoiceEntry } from "@/features/cards/queries";
import type { Category } from "@/features/categories/queries";
import type { TransactionItem } from "@/features/transactions/queries";
import { emptyMonthly, isoDate, type Overview } from "@/lib/overview";

export function demoTransactions(): TransactionItem[] {
  const base = {
    competenceDate: null,
    notes: null,
    transferGroupId: null,
    fromAccountId: null,
    toAccountId: null,
    cardId: null,
    invoiceId: null,
    installmentNumber: null,
    installmentTotal: null,
  };
  return demoMovements("demo-corrente").map((m) => ({
    ...base,
    id: m.id,
    postedAt: m.postedAt,
    description: m.description,
    amountCents: m.amountCents,
    kind: m.amountCents > 0 ? "income" : "expense",
    paymentMethod: m.amountCents > 0 ? null : "pix",
    accountId: "demo-corrente",
    categoryId: m.amountCents > 0 ? "demo-cat-salario" : "demo-cat-moradia",
  }));
}

export function demoCards(): Card[] {
  return [
    { id: "demo-card-a", name: "Cartão Demo A", institution: "Banco Fictício A", last4: "0000", limitCents: 1200000, closingDay: 10, dueDay: 20, archived: false },
    { id: "demo-card-b", name: "Cartão Demo B", institution: "Banco Fictício B", last4: null, limitCents: 800000, closingDay: 25, dueDay: 5, archived: false },
  ];
}

export function demoInvoices(cardId: string): Invoice[] {
  if (cardId !== "demo-card-a") return [];
  const now = new Date();
  const invoice = (offset: number, total: number, paid: number): Invoice => {
    const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return {
      id: `demo-invoice-${offset + 10}`,
      cardId,
      referenceMonth: isoDate(month),
      closingDate: isoDate(new Date(month.getFullYear(), month.getMonth(), 10)),
      dueDate: isoDate(new Date(month.getFullYear(), month.getMonth(), 20)),
      totalCents: total,
      paidCents: paid,
    };
  };
  return [invoice(-1, 321000, 321000), invoice(0, 438000, 0), invoice(1, 120000, 0)];
}

export function demoInvoiceEntries(): InvoiceEntry[] {
  const now = new Date();
  return [
    { id: "demo-entry-1", postedAt: isoDate(now), description: "Exemplo de compra parcelada", amountCents: -120000, categoryId: null, installmentNumber: 1, installmentTotal: 3, accountId: null },
    { id: "demo-entry-2", postedAt: isoDate(now), description: "Exemplo de compra à vista", amountCents: -318000, categoryId: null, installmentNumber: null, installmentTotal: null, accountId: null },
  ];
}

export function demoCategories(): Category[] {
  const base = { isSystem: true, archived: false };
  return [
    { ...base, id: "demo-cat-salario", name: "Salário", kind: "income", icon: "banknote", color: "#4ade80" },
    { ...base, id: "demo-cat-vendas", name: "Vendas", kind: "income", icon: "store", color: "#a78bfa" },
    { ...base, id: "demo-cat-alimentacao", name: "Alimentação", kind: "expense", icon: "utensils", color: "#fb923c" },
    { ...base, id: "demo-cat-moradia", name: "Moradia", kind: "expense", icon: "house", color: "#60a5fa" },
    { ...base, id: "demo-cat-lazer", name: "Lazer", kind: "expense", icon: "party-popper", color: "#f472b6" },
  ];
}

export function demoCategoryTotals(categoryId: string) {
  const totals: Record<string, [number, number]> = {
    "demo-cat-salario": [450000, 1],
    "demo-cat-alimentacao": [32650, 1],
    "demo-cat-moradia": [170000, 1],
  };
  const [periodCents, periodCount] = totals[categoryId] ?? [0, 0];
  return { periodCents, periodCount, totalCount: periodCount };
}

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
