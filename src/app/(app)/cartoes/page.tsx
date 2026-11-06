import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, CreditCard } from "lucide-react";
import { MigrationNotice } from "@/components/migration-notice";
import { Card, CardTitle, PageHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { LimitBar } from "@/features/cards/components/card-visuals";
import { NewCardButton } from "@/features/cards/components/new-card-button";
import { listCards, type CardSummary } from "@/features/cards/queries";
import { remainingCents } from "@/features/cards/status";
import { MigrationRequiredError } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";
import { formatBRL, formatDateFull } from "@/lib/utils";

export const metadata: Metadata = { title: "Cartões" };
export const dynamic = "force-dynamic";

const SUBTITLE = "Limites, faturas e parcelas de cada cartão.";

function CardRow({ card }: { card: CardSummary }) {
  return (
    <li>
      <Link
        href={`/cartoes/${card.id}`}
        className="-mx-2 block rounded-xl px-2 py-4 transition-colors hover:bg-raised active:bg-raised"
      >
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{card.name}</span>
            <span className="block truncate text-xs text-faint">
              {[card.institution, card.last4 ? `final ${card.last4}` : null].filter(Boolean).join(" · ")}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-right">
            <span>
              <span className="block text-sm font-medium tabular-nums">{formatBRL(card.availableCents)}</span>
              <span className="block text-[11px] text-muted">disponível</span>
            </span>
            <ChevronRight aria-hidden className="h-4 w-4 text-faint" />
          </span>
        </span>
        <span className="mt-3 block">
          <LimitBar name={card.name} usedCents={card.usedCents} limitCents={card.limitCents} />
        </span>
        <span className="mt-2 block text-xs text-muted">
          {card.nextInvoice
            ? `Próxima fatura: ${formatBRL(remainingCents(card.nextInvoice))} em ${formatDateFull(card.nextInvoice.dueDate)}`
            : `Fecha dia ${card.closingDay} · vence dia ${card.dueDay}`}
        </span>
      </Link>
    </li>
  );
}

export default async function CartoesPage() {
  const demo = !isSupabaseConfigured();

  let cards: CardSummary[];
  try {
    cards = await listCards();
  } catch (error) {
    if (error instanceof MigrationRequiredError) {
      return (
        <>
          <PageHeader title="Cartões" subtitle={SUBTITLE} />
          <MigrationNotice file="0006_cards.sql" />
        </>
      );
    }
    throw error;
  }

  const active = cards.filter((c) => !c.archived);
  const archived = cards.filter((c) => c.archived);

  return (
    <>
      <PageHeader
        title="Cartões"
        subtitle={SUBTITLE}
        badge={demo ? "Dados fictícios" : undefined}
        action={!demo && cards.length > 0 ? <NewCardButton /> : undefined}
      />

      {cards.length === 0 ? (
        <Card className="animate-rise">
          <EmptyState
            icon={CreditCard}
            title="Nenhum cartão cadastrado"
            description="Cadastre seus cartões para acompanhar limite, faturas e parcelas. Guardamos no máximo os 4 últimos dígitos."
            action={<NewCardButton label="Cadastrar primeiro cartão" />}
          />
        </Card>
      ) : (
        <>
          <section aria-label="Resumo" className="grid grid-cols-2 gap-3">
            <StatCard
              label="Limite disponível"
              value={formatBRL(active.reduce((sum, c) => sum + c.availableCents, 0))}
            />
            <StatCard
              label="Limite utilizado"
              value={formatBRL(active.reduce((sum, c) => sum + c.usedCents, 0))}
              hint="inclui parcelas futuras"
            />
          </section>

          <Card className="mt-3 animate-rise">
            <CardTitle>Cartões</CardTitle>
            {active.length === 0 ? (
              <p className="mt-4 text-sm text-muted">Todos os seus cartões estão arquivados.</p>
            ) : (
              <ul className="mt-1 divide-y divide-line">
                {active.map((c) => (
                  <CardRow key={c.id} card={c} />
                ))}
              </ul>
            )}
          </Card>

          {archived.length > 0 && (
            <Card className="mt-3 animate-rise">
              <details>
                <summary className="flex min-h-6 cursor-pointer list-none items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-muted">
                  <span>Arquivados</span>
                  <span className="tabular-nums">{archived.length}</span>
                </summary>
                <ul className="mt-1 divide-y divide-line">
                  {archived.map((c) => (
                    <CardRow key={c.id} card={c} />
                  ))}
                </ul>
              </details>
            </Card>
          )}
        </>
      )}
    </>
  );
}
