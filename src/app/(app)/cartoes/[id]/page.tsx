import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight, Receipt } from "lucide-react";
import { MigrationNotice } from "@/components/migration-notice";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { CardActions } from "@/features/cards/components/card-actions";
import { InvoiceStatusBadge, LimitBar } from "@/features/cards/components/card-visuals";
import { PurchaseButton } from "@/features/cards/components/purchase-button";
import { getCard, type Invoice } from "@/features/cards/queries";
import { groupInvoices, invoiceStatus, remainingCents } from "@/features/cards/status";
import { listCategories } from "@/features/categories/queries";
import { MigrationRequiredError } from "@/lib/action-result";
import { formatMonth, todayInSaoPaulo } from "@/lib/dates";
import { isSupabaseConfigured } from "@/lib/env";
import { formatBRL, formatDateFull } from "@/lib/utils";

export const metadata: Metadata = { title: "Cartão" };
export const dynamic = "force-dynamic";

function InvoiceRow({ cardId, invoice, today }: { cardId: string; invoice: Invoice; today: string }) {
  const status = invoiceStatus(invoice, today);
  return (
    <li>
      <Link
        href={`/cartoes/${cardId}/faturas/${invoice.id}`}
        className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-raised active:bg-raised"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{formatMonth(invoice.referenceMonth.slice(0, 7))}</span>
          <span className="block text-xs text-faint">Vence em {formatDateFull(invoice.dueDate)}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-sm font-medium tabular-nums">
            {formatBRL(status === "paid" ? invoice.totalCents : remainingCents(invoice))}
          </span>
          <span className="mt-1 block">
            <InvoiceStatusBadge status={status} />
          </span>
        </span>
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-faint" />
      </Link>
    </li>
  );
}

function InvoiceGroup({
  title,
  cardId,
  invoices,
  today,
}: {
  title: string;
  cardId: string;
  invoices: Invoice[];
  today: string;
}) {
  if (invoices.length === 0) return null;
  return (
    <Card className="mt-3 animate-rise">
      <CardTitle>{title}</CardTitle>
      <ul className="mt-1 divide-y divide-line">
        {invoices.map((invoice) => (
          <InvoiceRow key={invoice.id} cardId={cardId} invoice={invoice} today={today} />
        ))}
      </ul>
    </Card>
  );
}

export default async function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const demo = !isSupabaseConfigured();

  const back = (
    <Link
      href="/cartoes"
      className="mb-6 inline-flex animate-rise items-center gap-2 text-sm text-muted transition-colors hover:text-fg"
    >
      <ArrowLeft aria-hidden className="h-4 w-4" /> Cartões
    </Link>
  );

  let data;
  let categories;
  try {
    [data, categories] = await Promise.all([getCard(id), listCategories()]);
  } catch (error) {
    if (error instanceof MigrationRequiredError) {
      return (
        <>
          {back}
          <MigrationNotice file="0006_cards.sql" />
        </>
      );
    }
    throw error;
  }
  if (!data) notFound();

  const { card, invoices } = data;
  const today = todayInSaoPaulo();
  const { current, upcoming, previous } = groupInvoices(invoices, today);
  const overLimit = card.usedCents > card.limitCents;

  return (
    <>
      {back}

      <header className="mb-6 flex animate-rise flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="break-words text-2xl font-semibold tracking-tight md:text-3xl">{card.name}</h1>
            {card.archived && (
              <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                Arquivado
              </span>
            )}
            {demo && (
              <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                Dados fictícios
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            {[card.institution, card.last4 ? `final ${card.last4}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        {!demo && !card.archived && <PurchaseButton cardId={card.id} categories={categories} />}
      </header>

      <section className="grid gap-3 lg:grid-cols-5">
        <Card className="animate-rise lg:col-span-3">
          <CardTitle>Limite disponível</CardTitle>
          <p className="mb-4 mt-3 text-3xl font-semibold tabular-nums tracking-tight md:text-4xl">
            {formatBRL(card.availableCents)}
          </p>
          <LimitBar name={card.name} usedCents={card.usedCents} limitCents={card.limitCents} />
          {overLimit && (
            <p className="mt-2 text-xs text-fg">
              O uso passou do limite em {formatBRL(card.usedCents - card.limitCents)}.
            </p>
          )}
          {!demo && (
            <div className="mt-5">
              <CardActions card={card} />
            </div>
          )}
        </Card>

        <Card className="animate-rise lg:col-span-2">
          <CardTitle>Detalhes</CardTitle>
          <dl className="mt-2 divide-y divide-line text-sm">
            {[
              ["Limite total", formatBRL(card.limitCents)],
              ["Limite utilizado", formatBRL(card.usedCents)],
              ["Fechamento", `Dia ${card.closingDay}`],
              ["Vencimento", `Dia ${card.dueDay}`],
            ].map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 py-3">
                <dt className="text-muted">{label}</dt>
                <dd className="tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>

      {invoices.length === 0 ? (
        <Card className="mt-3 animate-rise">
          <EmptyState
            icon={Receipt}
            title="Nenhuma fatura ainda"
            description="As faturas são criadas automaticamente quando você registra uma compra neste cartão."
          />
        </Card>
      ) : (
        <>
          <InvoiceGroup title="Fatura atual" cardId={card.id} invoices={current ? [current] : []} today={today} />
          <InvoiceGroup title="Próximas faturas" cardId={card.id} invoices={upcoming} today={today} />
          <InvoiceGroup title="Faturas anteriores" cardId={card.id} invoices={previous} today={today} />
        </>
      )}
    </>
  );
}
