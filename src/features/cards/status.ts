export type InvoiceStatus = "open" | "closed" | "paid" | "overdue";

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  open: "Aberta",
  closed: "Fechada",
  paid: "Paga",
  overdue: "Atrasada",
};

type InvoiceDates = {
  totalCents: number;
  paidCents: number;
  closingDate: string;
  dueDate: string;
};

export function remainingCents(invoice: { totalCents: number; paidCents: number }): number {
  return Math.max(0, invoice.totalCents - invoice.paidCents);
}

/**
 * O status depende da data de hoje, por isso é calculado na leitura e não gravado:
 * uma fatura fica atrasada sozinha, sem nenhum processo rodando.
 * No dia do fechamento ela já está fechada, pois a compra desse dia entra na seguinte.
 */
export function invoiceStatus(invoice: InvoiceDates, today: string): InvoiceStatus {
  if (invoice.totalCents > 0 && invoice.paidCents >= invoice.totalCents) return "paid";
  if (invoice.dueDate < today && remainingCents(invoice) > 0) return "overdue";
  if (invoice.closingDate <= today) return "closed";
  return "open";
}

/** Limite usado: tudo que ainda não foi pago, inclusive as parcelas futuras. */
export function usedLimitCents(invoices: readonly { totalCents: number; paidCents: number }[]): number {
  return invoices.reduce((sum, invoice) => sum + remainingCents(invoice), 0);
}

type Groupable = InvoiceDates & { referenceMonth: string };

/** Atual: a primeira ainda aberta. Próximas: as abertas depois dela. Anteriores: as já fechadas. */
export function groupInvoices<T extends Groupable>(invoices: readonly T[], today: string) {
  const sorted = [...invoices].sort((a, b) => a.referenceMonth.localeCompare(b.referenceMonth));
  const openOnes = sorted.filter((i) => i.closingDate > today);
  return {
    current: openOnes[0] ?? null,
    upcoming: openOnes.slice(1),
    previous: sorted.filter((i) => i.closingDate <= today).reverse(),
  };
}

/** Próxima a pagar: a de vencimento mais cedo com saldo em aberto. */
export function nextInvoiceToPay<T extends Groupable>(invoices: readonly T[]): T | null {
  return (
    [...invoices]
      .filter((i) => remainingCents(i) > 0)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null
  );
}
