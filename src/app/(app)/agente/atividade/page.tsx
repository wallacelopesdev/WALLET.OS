import { History } from "lucide-react";
import { MigrationNotice } from "@/components/migration-notice";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ActivityList } from "@/features/agent/components/activity-list";
import { listActivity } from "@/features/agent/queries";
import { MigrationRequiredError } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  if (!isSupabaseConfigured()) return null;

  let items;
  try {
    items = await listActivity(200);
  } catch (error) {
    if (error instanceof MigrationRequiredError) return <MigrationNotice file="0008_agent_core.sql" />;
    throw error;
  }

  return (
    <Card className="animate-rise">
      <CardTitle>Linha do tempo</CardTitle>
      {items.length === 0 ? (
        <EmptyState
          icon={History}
          title="Nenhuma atividade ainda"
          description="Tudo o que o agente fizer aparece aqui: lançamentos registrados, duplicidades bloqueadas, faturas e alertas."
        />
      ) : (
        <ActivityList items={items} />
      )}
    </Card>
  );
}
