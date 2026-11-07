import Link from "next/link";
import { MigrationNotice } from "@/components/migration-notice";
import { buttonClass } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { ActivityList } from "@/features/agent/components/activity-list";
import { MarkAllRead, RecurringList } from "@/features/agent/components/recurring-list";
import { getAgentOverview } from "@/features/agent/queries";
import { MigrationRequiredError } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";
import { cn, formatTimestampDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AgentPage() {
  if (!isSupabaseConfigured()) return null;

  let data;
  try {
    data = await getAgentOverview();
  } catch (error) {
    if (error instanceof MigrationRequiredError) return <MigrationNotice file="0011_agent_automations.sql" />;
    throw error;
  }

  const { settings, connections, pending, processed, lastRuns, notifications, activity, recurring } = data;
  const lastSync = lastRuns.find((r) => r.kind === "sync");
  const failing = connections.filter((c) => c.status === "error" || c.status === "expired");
  const state = settings.paused
    ? { label: "Pausado", hint: "Nada se perde: o que chegar fica para revisar." }
    : failing.length > 0 || lastSync?.status === "failed"
      ? { label: "Com erro", hint: `${failing.length || 1} ${failing.length > 1 ? "conexões precisam" : "conexão precisa"} de atenção.` }
      : { label: "Ativo", hint: "Dentro das permissões que você definiu." };

  const unread = notifications.filter((n) => !n.readAt);

  return (
    <>
      <section aria-label="Resumo" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Estado" value={state.label} hint={state.hint} />
        <StatCard label="Para revisar" value={String(pending)} hint={pending === 0 ? "tudo em dia" : pending === 1 ? "aguarda sua decisão" : "aguardam sua decisão"} />
        <StatCard label="Processadas" value={String(processed)} hint="movimentações" />
        <StatCard
          label="Instituições"
          value={String(connections.length)}
          hint={lastSync ? `Última sincronização em ${formatTimestampDate(lastSync.startedAt)}` : "Ainda sem sincronização"}
        />
      </section>

      {pending > 0 && (
        <Link
          href="/agente/revisao"
          className="mt-3 flex animate-rise items-center justify-between gap-3 rounded-2xl border border-line-strong bg-raised px-5 py-3.5 text-sm transition-colors hover:border-fg"
        >
          <span>{pending === 1 ? "1 movimentação aguarda sua revisão" : `${pending} movimentações aguardam sua revisão`}</span>
          <span className="shrink-0 text-muted">Revisar</span>
        </Link>
      )}

      {connections.length === 0 && (
        <Card className="mt-3 animate-rise">
          <CardTitle>Comece conectando suas fontes</CardTitle>
          <p className="mt-3 text-sm text-muted">
            Sem uma fonte autorizada o agente não tem o que processar. Conecte um banco pelo Open Finance, configure os
            Atalhos do iPhone ou importe um extrato.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/agente/conexoes" className={buttonClass("primary")}>
              Conectar fontes
            </Link>
            <Link href="/agente/importar" className={buttonClass("secondary")}>
              Importar extrato
            </Link>
          </div>
        </Card>
      )}

      <section className="mt-3 grid items-start gap-3 lg:grid-cols-2">
        <Card className="animate-rise">
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Alertas</CardTitle>
            {unread.length > 0 && <MarkAllRead />}
          </div>
          {notifications.length === 0 ? (
            <p className="mt-4 text-sm text-muted">Nenhum alerta por enquanto.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {notifications.map((n) => {
                const content = (
                  <>
                    <span className={cn("block text-sm font-medium", n.readAt && "text-muted")}>
                      {n.severity === "critical" && (
                        <span className="mr-2 rounded-full bg-fg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink">
                          Urgente
                        </span>
                      )}
                      {n.title}
                    </span>
                    {n.body && <span className="mt-0.5 block text-xs text-faint">{n.body}</span>}
                  </>
                );
                return (
                  <li key={n.id} className="py-3">
                    {n.actionUrl ? (
                      <Link href={n.actionUrl} className="block transition-opacity hover:opacity-80">
                        {content}
                      </Link>
                    ) : (
                      content
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="animate-rise">
          <CardTitle>Atividade recente</CardTitle>
          {activity.length === 0 ? (
            <p className="mt-4 text-sm text-muted">O agente ainda não executou nenhuma ação.</p>
          ) : (
            <>
              <ActivityList items={activity} />
              <Link href="/agente/atividade" className="mt-2 inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-4 hover:text-fg">
                Ver toda a atividade
              </Link>
            </>
          )}
        </Card>
      </section>

      {recurring.length > 0 && (
        <Card className="mt-3 animate-rise">
          <CardTitle>Cobranças recorrentes</CardTitle>
          <RecurringList items={recurring} />
        </Card>
      )}
    </>
  );
}
