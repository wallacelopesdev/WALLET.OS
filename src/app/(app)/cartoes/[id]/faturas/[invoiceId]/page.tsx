import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { MigrationNotice } from "@/components/migration-notice";
import { Card, CardTitle } from "@/components/ui/card";
import { listAccounts } from "@/features/accounts/queries";
import { InvoiceStatusBadge } from "@/features/cards/components/card-visuals";
import { InvoiceEntries } from "@/features/cards/components/invoice-entries";
import { PayInvoiceButton } from "@/features/cards/components/pay-invoice-button";
import { getCard, getInvoice } from "@/features/cards/queries";
import { invoiceStatus, remainingCents } from "@/features/cards/status";
import { listCategories } from "@/features/categories/queries";
import { MigrationRequiredError } from "@/lib/action-result";
import { formatMonth, todayInSaoPaulo } from "@/lib/dates";
import { isSupabaseConfigured } from "@/lib/env";
import { formatBRL, formatDateFull } from "@/lib/utils";

export const metadata: Metadata = { title: "Fatura" };
export const dynamic = "force-dynamic";

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ id: string; invoiceId: string }>;
}) {
  const { id, invoiceId } = await params;
  const demo = !isSupabaseConfigured();

  let loaded;
  try {
    const [card, invoice, accounts, categories] = await Promise.all([
      getCard(id),
      getInvoice(id, invoiceId),
      listAccounts(),
      listCategories(),
    ]);
    loaded = { card, invoice, accounts, categories };
  } catch (error) {
    if (error instanceof MigrationRequiredError) {
      return <MigrationNotice file="0006_cards.sql" />;
    }
    throw error;
  }

  const { card, invoice: data, accounts, categories } = loaded;
  if (!card || !data) notFound();

  const { invoice, purchases, payments } = data;
  const today = todayInSaoPaulo();
  const status = invoiceStatus(invoice, today);
  const remaining = remainingCents(invoice);

  return (
    <>
      <Link
        href={`/cartoes/${id}`}
        className="mb-6 inline-flex animate-rise items-center gap-2 text-sm text-muted transition-colors hover:text-fg"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" /> {card.card.name}
      </Link>

      <header className="mb-6 animate-rise">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Fatura de {formatMonth(invoice.referenceMonth.slice(0, 7))}
          </h1>
          <InvoiceStatusBadge status={status} />
        </div>
        <p className="mt-1 text-sm text-muted">{card.card.name}</p>
      </header>

      <section className="grid gap-3 lg:grid-cols-5">
        <Card className="animate-rise lg:col-span-3">
          <CardTitle>{status === "paid" ? "Total pago" : "Saldo em aberto"}</CardTitle>
          <p className="mt-3 text-3xl font-semibold tabular-nums tracking-tight md:text-4xl">
            {formatBRL(status === "paid" ? invoice.paidCents : remaining)}
          </p>
          {status === "overdue" && (
            <p className="mt-2 text-xs text-fg">Venceu em {formatDateFull(invoice.dueDate)}.</p>
          )}
          {!demo && remaining > 0 && (
            <div className="mt-5">
              <PayInvoiceButton invoiceId={invoice.id} remaining={remaining} accounts={accounts} />
            </div>
          )}
        </Card>

        <Card className="animate-rise lg:col-span-2">
          <CardTitle>Detalhes</CardTitle>
          <dl className="mt-2 divide-y divide-line text-sm">
            {[
              ["Valor total", formatBRL(invoice.totalCents)],
              ["Valor pago", formatBRL(invoice.paidCents)],
              ["Fechamento", formatDateFull(invoice.closingDate)],
              ["Vencimento", formatDateFull(invoice.dueDate)],
            ].map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 py-3">
                <dt className="text-muted">{label}</dt>
                <dd className="tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>

      <Card className="mt-3 animate-rise">
        <InvoiceEntries
          purchases={purchases}
          payments={payments}
          accounts={accounts}
          categories={categories}
          readOnly={demo}
        />
      </Card>
    </>
  );
}
