import type { Metadata } from "next";
import Link from "next/link";
import { IncomeExpenseChart } from "@/components/charts/income-expense-chart";
import { Card, CardTitle, PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { getOverview, monthDelta } from "@/lib/overview";
import { cn, formatBRL, formatDate, formatPercent } from "@/lib/utils";

export const metadata: Metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const o = await getOverview();
  const available = o.balanceCents - o.openInvoicesCents;
  const today = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={today.charAt(0).toUpperCase() + today.slice(1)}
        badge={o.isDemo ? "Dados fictícios" : undefined}
      />

      {!o.hasData && (
        <Card className="mb-6 animate-rise">
          <CardTitle>Comece por aqui</CardTitle>
          <p className="mt-3 max-w-xl text-sm text-muted">
            Sua conta está pronta, mas ainda não há contas, cartões ou
            transações.{" "}
            <Link href="/financeiro" className="text-fg underline underline-offset-4">
              Cadastre sua primeira conta
            </Link>{" "}
            para começar. Enquanto não houver movimentações, os indicadores
            abaixo permanecem zerados.
          </p>
        </Card>
      )}

      <section
        aria-label="Indicadores do mês"
        className="grid grid-cols-2 gap-3 lg:grid-cols-3"
      >
        <StatCard label="Saldo total" value={formatBRL(o.balanceCents)} />
        <StatCard
          label="Receitas do mês"
          value={formatBRL(o.incomeCents)}
          delta={monthDelta(o.monthly, "incomeCents")}
          hint="vs. mês anterior"
        />
        <StatCard
          label="Despesas do mês"
          value={formatBRL(o.expenseCents)}
          delta={monthDelta(o.monthly, "expenseCents")}
          lowerIsBetter
          hint="vs. mês anterior"
        />
        <StatCard
          label="Saldo disponível"
          value={formatBRL(available)}
          hint="após faturas abertas"
        />
        <StatCard label="Gastos no cartão" value={formatBRL(o.cardSpendCents)} hint="neste mês" />
        <StatCard label="Faturas abertas" value={formatBRL(o.openInvoicesCents)} />
      </section>

      <section className="mt-3 grid gap-3 lg:grid-cols-5">
        <Card className="animate-rise lg:col-span-3">
          <CardTitle>Receitas × despesas · 6 meses</CardTitle>
          <div className="mt-4">
            <IncomeExpenseChart data={o.monthly} />
          </div>
        </Card>

        <Card className="animate-rise lg:col-span-2">
          <CardTitle>Limites dos cartões</CardTitle>
          {o.cards.length === 0 ? (
            <p className="mt-4 text-sm text-muted">Nenhum cartão cadastrado.</p>
          ) : (
            <ul className="mt-4 space-y-5">
              {o.cards.map((c) => {
                const pct =
                  c.limitCents > 0
                    ? Math.min(100, (c.usedCents / c.limitCents) * 100)
                    : 0;
                return (
                  <li key={c.id}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="truncate font-medium">{c.name}</span>
                      <span className="tabular-nums text-muted">
                        {formatPercent(pct)}
                      </span>
                    </div>
                    <div
                      className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"
                      role="progressbar"
                      aria-valuenow={Math.round(pct)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`Limite utilizado do ${c.name}`}
                    >
                      <div
                        className={cn(
                          "h-full rounded-full transition-[width] duration-700",
                          pct >= 80 ? "bg-fg" : "bg-[#8c8c8c]",
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="mt-1.5 text-xs tabular-nums text-faint">
                      {formatBRL(c.usedCents)} de {formatBRL(c.limitCents)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      <Card className="mt-3 animate-rise">
        <CardTitle>Próximos vencimentos</CardTitle>
        {o.upcoming.length === 0 ? (
          <p className="mt-4 text-sm text-muted">Nada a vencer por enquanto.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {o.upcoming.map((u) => (
              <li key={u.id} className="flex items-center justify-between py-3.5">
                <div>
                  <p className="text-sm font-medium">{u.label}</p>
                  <p className="text-xs text-faint">{formatDate(u.dueDate)}</p>
                </div>
                <p className="text-sm tabular-nums">{formatBRL(u.amountCents)}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
