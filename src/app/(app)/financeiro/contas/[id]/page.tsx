import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowLeftRight } from "lucide-react";
import { MigrationNotice } from "@/components/migration-notice";
import { buttonClass } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { AccountActions } from "@/features/accounts/components/account-actions";
import { AccountIcon } from "@/features/accounts/components/account-icon";
import { MovementsList } from "@/features/accounts/components/movements-list";
import {
  ACCOUNT_KIND_LABELS,
  MOVEMENTS_MAX,
  MOVEMENTS_PAGE_SIZE,
} from "@/features/accounts/constants";
import { getAccount, listAccountMovements } from "@/features/accounts/queries";
import { MigrationRequiredError } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";
import { cn, formatBRL, formatTimestampDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Conta" };
export const dynamic = "force-dynamic";

function parseLimit(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MOVEMENTS_PAGE_SIZE) return MOVEMENTS_PAGE_SIZE;
  return Math.min(value, MOVEMENTS_MAX);
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right tabular-nums">{value}</dd>
    </div>
  );
}

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ limite?: string }>;
}) {
  const { id } = await params;
  const { limite } = await searchParams;
  const limit = parseLimit(limite);
  const demo = !isSupabaseConfigured();

  const back = (
    <Link
      href="/financeiro"
      className="mb-6 inline-flex animate-rise items-center gap-2 text-sm text-muted transition-colors hover:text-fg"
    >
      <ArrowLeft aria-hidden className="h-4 w-4" /> Contas
    </Link>
  );

  let account;
  let page;
  try {
    account = await getAccount(id);
    if (!account) notFound();
    page = await listAccountMovements(account.id, limit);
  } catch (error) {
    if (error instanceof MigrationRequiredError) {
      return (
        <>
          {back}
          <MigrationNotice file="0002_accounts.sql" />
        </>
      );
    }
    throw error;
  }

  const { movements, total } = page;
  const canLoadMore = movements.length < total && limit < MOVEMENTS_MAX;
  const negative = account.balanceCents < 0;

  return (
    <>
      {back}

      <header className="mb-6 animate-rise">
        <div className="flex items-start gap-3">
          <AccountIcon kind={account.kind} archived={account.archived} className="h-12 w-12" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="break-words text-2xl font-semibold tracking-tight md:text-3xl">
                {account.name}
              </h1>
              {account.archived && (
                <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                  Arquivada
                </span>
              )}
              {demo && (
                <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                  Dados fictícios
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted">
              {[account.institution, ACCOUNT_KIND_LABELS[account.kind]]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
      </header>

      <section className="grid gap-3 lg:grid-cols-5">
        <Card className="animate-rise lg:col-span-3">
          <CardTitle>Saldo atual</CardTitle>
          <p
            className={cn(
              "mt-3 text-3xl font-semibold tabular-nums tracking-tight md:text-4xl",
              account.archived && "text-muted",
            )}
          >
            {formatBRL(account.balanceCents)}
          </p>
          {negative && <p className="mt-2 text-xs text-muted">Saldo negativo</p>}
          {account.archived && (
            <p className="mt-2 text-xs text-faint">Fora do saldo total.</p>
          )}
          {!demo && (
            <div className="mt-5">
              <AccountActions account={account} hasMovements={total > 0} />
            </div>
          )}
        </Card>

        <Card className="animate-rise lg:col-span-2">
          <CardTitle>Detalhes</CardTitle>
          <dl className="mt-2 divide-y divide-line">
            <Detail label="Saldo inicial" value={formatBRL(account.openingBalanceCents)} />
            <Detail label="Movimentações" value={String(total)} />
            <Detail label="Criada em" value={formatTimestampDate(account.createdAt)} />
          </dl>
        </Card>
      </section>

      <Card className="mt-3 animate-rise">
        <CardTitle>Movimentações</CardTitle>
        {movements.length === 0 ? (
          <EmptyState
            icon={ArrowLeftRight}
            title="Nenhuma movimentação"
            description="Os lançamentos desta conta aparecerão aqui, do mais recente para o mais antigo."
            action={
              !demo && !account.archived ? (
                <Link
                  href={`/transacoes?conta=${account.id}`}
                  className={buttonClass("secondary")}
                >
                  Registrar em Transações
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <MovementsList movements={movements} />
            {!demo && (
              <Link
                href={`/transacoes?conta=${account.id}`}
                className="mt-3 inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-4 transition-colors hover:text-fg"
              >
                Editar ou lançar em Transações
              </Link>
            )}
            {canLoadMore && (
              <Link
                href={`/financeiro/contas/${account.id}?limite=${limit + MOVEMENTS_PAGE_SIZE}`}
                scroll={false}
                replace
                className={buttonClass("secondary", "mt-3 w-full")}
              >
                Carregar mais
              </Link>
            )}
            {movements.length < total && !canLoadMore && (
              <p className="mt-3 text-center text-xs text-faint">
                Exibindo as {movements.length} movimentações mais recentes de {total}.
              </p>
            )}
          </>
        )}
      </Card>
    </>
  );
}
