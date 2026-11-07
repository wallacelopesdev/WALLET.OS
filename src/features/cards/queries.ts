import { MigrationRequiredError, isSchemaOutdated } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { idSchema } from "./schema";
import { nextInvoiceToPay, usedLimitCents } from "./status";

export type Card = {
  id: string;
  name: string;
  institution: string;
  last4: string | null;
  limitCents: number;
  closingDay: number;
  dueDay: number;
  archived: boolean;
};

export type Invoice = {
  id: string;
  cardId: string;
  referenceMonth: string;
  closingDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
};

export type CardSummary = Card & {
  usedCents: number;
  availableCents: number;
  nextInvoice: Invoice | null;
  invoiceCount: number;
  openInvoices: Invoice[];
};

export type InvoiceEntry = {
  id: string;
  postedAt: string;
  description: string;
  amountCents: number;
  categoryId: string | null;
  installmentNumber: number | null;
  installmentTotal: number | null;
  accountId: string | null;
};

type CardRow = {
  id: string;
  name: string;
  institution: string;
  last4: string | null;
  limit_cents: number;
  closing_day: number;
  due_day: number;
  archived: boolean;
};

type InvoiceRow = {
  id: string;
  card_id: string;
  reference_month: string;
  closing_date: string;
  due_date: string;
  total_cents: number;
  paid_cents: number;
};

const CARD_COLUMNS = "id,name,institution,last4,limit_cents,closing_day,due_day,archived";
const INVOICE_COLUMNS = "id,card_id,reference_month,closing_date,due_date,total_cents,paid_cents";

const toCard = (r: CardRow): Card => ({
  id: r.id,
  name: r.name,
  institution: r.institution,
  last4: r.last4,
  limitCents: Number(r.limit_cents),
  closingDay: r.closing_day,
  dueDay: r.due_day,
  archived: r.archived,
});

const toInvoice = (r: InvoiceRow): Invoice => ({
  id: r.id,
  cardId: r.card_id,
  referenceMonth: r.reference_month,
  closingDate: r.closing_date,
  dueDate: r.due_date,
  totalCents: Number(r.total_cents),
  paidCents: Number(r.paid_cents),
});

function fail(error: { code?: string }, context: string): never {
  if (isSchemaOutdated(error)) throw new MigrationRequiredError();
  console.error(`[${context}] erro de banco, código ${error.code ?? "desconhecido"}`);
  throw new Error("Falha ao carregar os dados.");
}

function summarize(card: Card, invoices: Invoice[]): CardSummary {
  const usedCents = usedLimitCents(invoices);
  return {
    ...card,
    usedCents,
    availableCents: Math.max(0, card.limitCents - usedCents),
    nextInvoice: nextInvoiceToPay(invoices),
    invoiceCount: invoices.length,
    openInvoices: invoices
      .filter((i) => i.totalCents > i.paidCents)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
  };
}

export async function listCards(): Promise<CardSummary[]> {
  if (!isSupabaseConfigured()) {
    const { demoCards, demoInvoices } = await import("@/lib/demo-data");
    return demoCards().map((c) => summarize(c, demoInvoices(c.id)));
  }

  const supabase = await createClient();
  const [cards, invoices] = await Promise.all([
    supabase.from("credit_cards").select(CARD_COLUMNS).order("name"),
    supabase.from("card_invoices").select(INVOICE_COLUMNS),
  ]);
  if (cards.error) fail(cards.error, "listCards");
  if (invoices.error) fail(invoices.error, "listCards.invoices");

  const all = (invoices.data as InvoiceRow[]).map(toInvoice);
  return (cards.data as CardRow[]).map((row) =>
    summarize(toCard(row), all.filter((i) => i.cardId === row.id)),
  );
}

export async function getCard(
  id: string,
): Promise<{ card: CardSummary; invoices: Invoice[] } | null> {
  if (!isSupabaseConfigured()) {
    const { demoCards, demoInvoices } = await import("@/lib/demo-data");
    const card = demoCards().find((c) => c.id === id);
    if (!card) return null;
    const invoices = demoInvoices(id);
    return { card: summarize(card, invoices), invoices };
  }

  if (!idSchema.safeParse(id).success) return null;

  const supabase = await createClient();
  const [card, invoices] = await Promise.all([
    supabase.from("credit_cards").select(CARD_COLUMNS).eq("id", id).maybeSingle(),
    supabase.from("card_invoices").select(INVOICE_COLUMNS).eq("card_id", id),
  ]);
  if (card.error) fail(card.error, "getCard");
  if (invoices.error) fail(invoices.error, "getCard.invoices");
  if (!card.data) return null;

  const list = (invoices.data as InvoiceRow[]).map(toInvoice);
  return { card: summarize(toCard(card.data as CardRow), list), invoices: list };
}

export async function getInvoice(
  cardId: string,
  invoiceId: string,
): Promise<{ invoice: Invoice; purchases: InvoiceEntry[]; payments: InvoiceEntry[] } | null> {
  if (!isSupabaseConfigured()) {
    const { demoInvoices, demoInvoiceEntries } = await import("@/lib/demo-data");
    const invoice = demoInvoices(cardId).find((i) => i.id === invoiceId);
    return invoice ? { invoice, purchases: demoInvoiceEntries(), payments: [] } : null;
  }

  if (!idSchema.safeParse(invoiceId).success || !idSchema.safeParse(cardId).success) return null;

  const supabase = await createClient();
  const [invoice, entries] = await Promise.all([
    supabase
      .from("card_invoices")
      .select(INVOICE_COLUMNS)
      .eq("id", invoiceId)
      .eq("card_id", cardId)
      .maybeSingle(),
    supabase
      .from("transactions")
      .select("id,posted_at,description,amount_cents,kind,category_id,installment_number,installment_total,account_id")
      .eq("invoice_id", invoiceId)
      .order("posted_at", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);
  if (invoice.error) fail(invoice.error, "getInvoice");
  if (entries.error) fail(entries.error, "getInvoice.entries");
  if (!invoice.data) return null;

  type EntryRow = {
    id: string;
    posted_at: string;
    description: string;
    amount_cents: number;
    kind: string;
    category_id: string | null;
    installment_number: number | null;
    installment_total: number | null;
    account_id: string | null;
  };

  const toEntry = (r: EntryRow): InvoiceEntry => ({
    id: r.id,
    postedAt: r.posted_at,
    description: r.description,
    amountCents: Number(r.amount_cents),
    categoryId: r.category_id,
    installmentNumber: r.installment_number,
    installmentTotal: r.installment_total,
    accountId: r.account_id,
  });

  const rows = entries.data as EntryRow[];
  return {
    invoice: toInvoice(invoice.data as InvoiceRow),
    purchases: rows.filter((r) => r.kind !== "invoice_payment").map(toEntry),
    payments: rows.filter((r) => r.kind === "invoice_payment").map(toEntry),
  };
}
