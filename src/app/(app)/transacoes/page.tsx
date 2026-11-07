import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeftRight, Landmark, SearchX } from "lucide-react";
import { MigrationNotice } from "@/components/migration-notice";
import { buttonClass } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { listAccounts } from "@/features/accounts/queries";
import { countPendingCaptures } from "@/features/agent/queries";
import { listCards } from "@/features/cards/queries";
import { listCategories } from "@/features/categories/queries";
import { NewTransactionButton } from "@/features/transactions/components/new-transaction-button";
import { TransactionFilters } from "@/features/transactions/components/transaction-filters";
import { TransactionList } from "@/features/transactions/components/transaction-list";
import { TRANSACTIONS_PAGE_SIZE } from "@/features/transactions/constants";
import { listTransactions } from "@/features/transactions/queries";
import {
  filtersToQuery,
  hasActiveFilters,
  parseTransactionFilters,
} from "@/features/transactions/schema";
import { MigrationRequiredError } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";

export const metadata: Metadata = { title: "Transações" };
export const dynamic = "force-dynamic";

const SUBTITLE = "Receitas, despesas e transferências em um só lugar.";

async function loadData(filters: ReturnType<typeof parseTransactionFilters>) {
  const [page, accounts, categories, cards, pendingCaptures] = await Promise.all([
    listTransactions(filters),
    listAccounts(),
    listCategories(),
    listCards(),
    countPendingCaptures(),
  ]);
  return { page, accounts, categories, cards, pendingCaptures };
}

export default async function TransacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseTransactionFilters(await searchParams);
  const demo = !isSupabaseConfigured();

  let data: Awaited<ReturnType<typeof loadData>>;
  try {
    data = await loadData(filters);
  } catch (error) {
    if (error instanceof MigrationRequiredError) {
      return (
        <>
          <PageHeader title="Transações" subtitle={SUBTITLE} />
          <MigrationNotice file="0006_cards.sql" />
        </>
      );
    }
    throw error;
  }

  const { page, accounts, categories, cards, pendingCaptures } = data;
  const { items, total } = page;
  const hasActiveAccount = accounts.some((a) => !a.archived);
  const filtered = hasActiveFilters(filters);
  const totalPages = Math.max(1, Math.ceil(total / TRANSACTIONS_PAGE_SIZE));

  const newButton =
    !demo && hasActiveAccount ? (
      <NewTransactionButton
        accounts={accounts}
        categories={categories}
        defaultAccountId={filters.accountId}
      />
    ) : undefined;

  return (
    <>
      <PageHeader
        title="Transações"
        subtitle={SUBTITLE}
        badge={demo ? "Dados fictícios" : undefined}
        action={newButton}
      />

      {pendingCaptures > 0 && (
        <Link
          href="/agente/revisao"
          className="mb-3 flex animate-rise items-center justify-between gap-3 rounded-2xl border border-line-strong bg-raised px-5 py-3.5 text-sm transition-colors hover:border-fg"
        >
          <span>
            {pendingCaptures === 1
              ? "1 lançamento capturado aguarda revisão"
              : `${pendingCaptures} lançamentos capturados aguardam revisão`}
          </span>
          <span className="shrink-0 text-muted">Revisar</span>
        </Link>
      )}

      {!demo && (
        <div className="mb-3">
          <TransactionFilters filters={filters} accounts={accounts} categories={categories} />
        </div>
      )}

      <Card className="animate-rise">
        {items.length === 0 ? (
          !hasActiveAccount && !demo ? (
            <EmptyState
              icon={Landmark}
              title="Cadastre uma conta primeiro"
              description="Todo lançamento pertence a uma conta. Depois de cadastrá-la, registre aqui suas receitas, despesas e transferências."
              action={
                <Link href="/financeiro" className={buttonClass("primary")}>
                  Ir para contas
                </Link>
              }
            />
          ) : filtered || filters.page > 1 ? (
            <EmptyState
              icon={SearchX}
              title="Nenhum lançamento encontrado"
              description="Ajuste a busca ou os filtros para ver outros resultados."
              action={
                <Link href="/transacoes" className={buttonClass("secondary")}>
                  Limpar filtros
                </Link>
              }
            />
          ) : (
            <EmptyState
              icon={ArrowLeftRight}
              title="Nenhum lançamento ainda"
              description="Registre sua primeira receita, despesa ou transferência. Os saldos das contas são atualizados automaticamente."
            />
          )
        ) : (
          <>
            <p className="mb-1 text-xs text-faint">
              {total === 1 ? "1 lançamento" : `${total} lançamentos`}
            </p>
            <TransactionList
              items={items}
              accounts={accounts}
              categories={categories}
              cards={cards}
              readOnly={demo}
            />
            {totalPages > 1 && (
              <nav
                aria-label="Paginação"
                className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3"
              >
                {filters.page > 1 ? (
                  <Link
                    href={`/transacoes${filtersToQuery(filters, filters.page - 1)}`}
                    className={buttonClass("secondary")}
                  >
                    Anterior
                  </Link>
                ) : (
                  <span />
                )}
                <span className="text-xs tabular-nums text-muted">
                  Página {filters.page} de {totalPages}
                </span>
                {filters.page < totalPages ? (
                  <Link
                    href={`/transacoes${filtersToQuery(filters, filters.page + 1)}`}
                    className={buttonClass("secondary")}
                  >
                    Próxima
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            )}
          </>
        )}
      </Card>
    </>
  );
}
