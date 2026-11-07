import { MigrationNotice } from "@/components/migration-notice";
import { listAccounts } from "@/features/accounts/queries";
import { PendingPanel } from "@/features/agent/components/pending-panel";
import { listPending } from "@/features/agent/queries";
import { listCards } from "@/features/cards/queries";
import { remainingCents } from "@/features/cards/status";
import { MigrationRequiredError } from "@/lib/action-result";
import { formatMonth } from "@/lib/dates";
import { isSupabaseConfigured } from "@/lib/env";
import { formatBRL } from "@/lib/utils";
import { toTargets } from "../targets";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  if (!isSupabaseConfigured()) return null;

  let loaded;
  try {
    const [events, accounts, cards] = await Promise.all([listPending(), listAccounts(), listCards()]);
    loaded = { events, accounts, cards };
  } catch (error) {
    if (error instanceof MigrationRequiredError) return <MigrationNotice file="0008_agent_core.sql" />;
    throw error;
  }

  const invoices = loaded.cards.flatMap((c) =>
    c.openInvoices.map((i) => ({
      id: i.id,
      label: `${c.name} · ${formatMonth(i.referenceMonth.slice(0, 7))} · ${formatBRL(remainingCents(i))}`,
    })),
  );

  return <PendingPanel events={loaded.events} targets={toTargets(loaded.accounts, loaded.cards)} invoices={invoices} />;
}
