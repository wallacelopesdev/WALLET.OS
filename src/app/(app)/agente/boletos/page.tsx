import { MigrationNotice } from "@/components/migration-notice";
import { BillsPanel, type Bill } from "@/features/agent/components/bills-panel";
import { isSchemaOutdated } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function BillsPage() {
  if (!isSupabaseConfigured()) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bills")
    .select("id,beneficiary,amount_cents,due_date,paid_at,paid_amount_cents")
    .eq("dismissed", false)
    .order("due_date");

  if (isSchemaOutdated(error)) return <MigrationNotice file="0009_agent_bills.sql" />;
  if (error) throw new Error("Falha ao carregar os boletos.");

  const bills: Bill[] = data.map((b) => ({
    id: b.id,
    beneficiary: b.beneficiary,
    amountCents: Number(b.amount_cents),
    dueDate: b.due_date,
    paidAt: b.paid_at,
    paidAmountCents: b.paid_amount_cents === null ? null : Number(b.paid_amount_cents),
  }));

  return <BillsPanel bills={bills} />;
}
