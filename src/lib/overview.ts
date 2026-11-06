import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export type MonthPoint = {
  label: string;
  incomeCents: number;
  expenseCents: number;
};
export type CardUsage = {
  id: string;
  name: string;
  institution: string;
  limitCents: number;
  usedCents: number;
};
export type Upcoming = {
  id: string;
  label: string;
  dueDate: string; // YYYY-MM-DD
  amountCents: number;
};
export type Overview = {
  isDemo: boolean;
  hasData: boolean;
  balanceCents: number;
  incomeCents: number;
  expenseCents: number;
  cardSpendCents: number;
  openInvoicesCents: number;
  monthly: MonthPoint[];
  cards: CardUsage[];
  upcoming: Upcoming[];
};

const monthLabel = (d: Date) =>
  new Intl.DateTimeFormat("pt-BR", { month: "short" })
    .format(d)
    .replace(".", "");

export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function lastMonths(count = 6, ref = new Date()): Date[] {
  return Array.from(
    { length: count },
    (_, i) => new Date(ref.getFullYear(), ref.getMonth() - (count - 1 - i), 1),
  );
}

export function emptyMonthly(): MonthPoint[] {
  return lastMonths().map((d) => ({
    label: monthLabel(d),
    incomeCents: 0,
    expenseCents: 0,
  }));
}

/** Variação percentual do último mês vs. o anterior. */
export function monthDelta(
  monthly: MonthPoint[],
  key: "incomeCents" | "expenseCents",
): number | null {
  if (monthly.length < 2) return null;
  const prev = monthly[monthly.length - 2][key];
  const curr = monthly[monthly.length - 1][key];
  if (prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

type Row = Record<string, unknown>;

export async function getOverview(): Promise<Overview> {
  if (!isSupabaseConfigured()) {
    const { demoOverview } = await import("@/lib/demo-data");
    return demoOverview();
  }

  const supabase = await createClient();
  const months = lastMonths();
  const from = isoDate(months[0]);

  const [accounts, txs, cards, invoices] = await Promise.all([
    supabase.from("bank_accounts").select("balance_cents").eq("archived", false),
    supabase
      .from("transactions")
      .select("amount_cents,kind,posted_at,card_id")
      .gte("posted_at", from),
    supabase
      .from("credit_cards")
      .select("id,name,institution,limit_cents")
      .eq("archived", false),
    supabase
      .from("card_invoices")
      .select("id,card_id,total_cents,due_date,status,credit_cards(name)")
      .neq("status", "paid")
      .order("due_date"),
  ]);

  const failed = [accounts, txs, cards, invoices].find((r) => r.error);
  if (failed?.error) throw new Error(failed.error.message);

  const accountRows = (accounts.data ?? []) as Row[];
  const txRows = (txs.data ?? []) as Row[];
  const cardRows = (cards.data ?? []) as Row[];
  const invoiceRows = (invoices.data ?? []) as Row[];

  const monthly = emptyMonthly();
  const keys = months.map((d) => isoDate(d).slice(0, 7));
  let cardSpendCents = 0;

  for (const t of txRows) {
    const kind = String(t.kind);
    if (kind === "transfer" || kind === "invoice_payment") continue;
    const amount = Number(t.amount_cents);
    const idx = keys.indexOf(String(t.posted_at).slice(0, 7));
    if (idx === -1) continue;
    if (amount > 0) monthly[idx].incomeCents += amount;
    else {
      monthly[idx].expenseCents += -amount;
      if (t.card_id && idx === keys.length - 1) cardSpendCents += -amount;
    }
  }

  const usedByCard = new Map<string, number>();
  let openInvoicesCents = 0;
  for (const inv of invoiceRows) {
    const total = Number(inv.total_cents);
    openInvoicesCents += total;
    const id = String(inv.card_id);
    usedByCard.set(id, (usedByCard.get(id) ?? 0) + total);
  }

  const cardUsage: CardUsage[] = cardRows.map((c) => ({
    id: String(c.id),
    name: String(c.name),
    institution: String(c.institution),
    limitCents: Number(c.limit_cents),
    usedCents: usedByCard.get(String(c.id)) ?? 0,
  }));

  const upcoming: Upcoming[] = invoiceRows.slice(0, 5).map((inv) => {
    const rel = inv.credit_cards as { name?: string } | { name?: string }[] | null;
    const name = Array.isArray(rel) ? rel[0]?.name : rel?.name;
    return {
      id: String(inv.id),
      label: `Fatura ${name ?? "cartão"}`,
      dueDate: String(inv.due_date),
      amountCents: Number(inv.total_cents),
    };
  });

  const current = monthly[monthly.length - 1];

  return {
    isDemo: false,
    hasData:
      accountRows.length > 0 || cardRows.length > 0 || txRows.length > 0,
    balanceCents: accountRows.reduce(
      (sum, a) => sum + Number(a.balance_cents),
      0,
    ),
    incomeCents: current.incomeCents,
    expenseCents: current.expenseCents,
    cardSpendCents,
    openInvoicesCents,
    monthly,
    cards: cardUsage,
    upcoming,
  };
}
