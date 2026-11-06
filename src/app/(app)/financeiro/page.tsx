import type { Metadata } from "next";
import { Landmark } from "lucide-react";
import { MigrationNotice } from "@/components/migration-notice";
import { Card, CardTitle, PageHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { AccountRow } from "@/features/accounts/components/account-row";
import { FlashToast } from "@/features/accounts/components/flash-toast";
import { NewAccountButton } from "@/features/accounts/components/new-account-button";
import { listAccounts, type Account } from "@/features/accounts/queries";
import { FinanceTabs } from "@/features/categories/components/finance-tabs";
import { MigrationRequiredError } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";
import { formatBRL } from "@/lib/utils";

export const metadata: Metadata = { title: "Financeiro" };
export const dynamic = "force-dynamic";

const FLASH_MESSAGES: Record<string, string> = {
  "conta-excluida": "Conta excluída.",
};

export default async function FinanceiroPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string }>;
}) {
  const { aviso } = await searchParams;
  const demo = !isSupabaseConfigured();
  const subtitle = "Suas contas e saldos.";

  let accounts: Account[];
  try {
    accounts = await listAccounts();
  } catch (error) {
    if (error instanceof MigrationRequiredError) {
      return (
        <>
          <PageHeader title="Financeiro" subtitle={subtitle} />
          <MigrationNotice file="0002_accounts.sql" />
        </>
      );
    }
    throw error;
  }

  const active = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);
  const total = active.reduce((sum, a) => sum + a.balanceCents, 0);
  const flash = aviso ? FLASH_MESSAGES[aviso] : undefined;

  return (
    <>
      {flash && <FlashToast message={flash} path="/financeiro" />}

      <PageHeader
        title="Financeiro"
        subtitle={subtitle}
        badge={demo ? "Dados fictícios" : undefined}
        action={!demo && accounts.length > 0 ? <NewAccountButton /> : undefined}
      />
      <FinanceTabs active="contas" />

      {accounts.length === 0 ? (
        <Card className="animate-rise">
          <EmptyState
            icon={Landmark}
            title="Nenhuma conta cadastrada"
            description="Cadastre suas contas, carteiras e investimentos para acompanhar seus saldos em um só lugar."
            action={<NewAccountButton label="Cadastrar primeira conta" />}
          />
        </Card>
      ) : (
        <>
          <section aria-label="Resumo" className="grid grid-cols-2 gap-3">
            <StatCard label="Saldo total" value={formatBRL(total)} hint="contas ativas" />
            <StatCard label="Contas ativas" value={String(active.length)} />
          </section>

          <Card className="mt-3 animate-rise">
            <CardTitle>Contas</CardTitle>
            {active.length === 0 ? (
              <p className="mt-4 text-sm text-muted">
                Todas as suas contas estão arquivadas.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {active.map((a) => (
                  <AccountRow key={a.id} account={a} />
                ))}
              </ul>
            )}
          </Card>

          {archived.length > 0 && (
            <Card className="mt-3 animate-rise">
              <details>
                <summary className="flex min-h-6 cursor-pointer list-none items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-muted">
                  <span>Arquivadas</span>
                  <span className="tabular-nums">{archived.length}</span>
                </summary>
                <ul className="mt-2 divide-y divide-line">
                  {archived.map((a) => (
                    <AccountRow key={a.id} account={a} />
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
