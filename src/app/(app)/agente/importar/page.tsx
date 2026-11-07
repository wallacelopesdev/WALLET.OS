import { MigrationNotice } from "@/components/migration-notice";
import { listAccounts } from "@/features/accounts/queries";
import { ImportPanel, type BatchSummary } from "@/features/agent/components/import-panel";
import { listCards } from "@/features/cards/queries";
import { listCategories } from "@/features/categories/queries";
import { MigrationRequiredError, isSchemaOutdated } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { toTargets } from "../targets";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  if (!isSupabaseConfigured()) return null;

  let loaded;
  try {
    const [accounts, cards, categories] = await Promise.all([listAccounts(), listCards(), listCategories()]);
    loaded = { accounts, cards, categories };
  } catch (error) {
    if (error instanceof MigrationRequiredError) return <MigrationNotice file="0010_agent_connections.sql" />;
    throw error;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("import_batches")
    .select("id,file_name,format,status,rows_total,rows_inserted,rows_duplicated,error,created_at,card_id")
    .order("created_at", { ascending: false })
    .limit(20);
  if (isSchemaOutdated(error)) return <MigrationNotice file="0010_agent_connections.sql" />;
  if (error) throw new Error("Falha ao carregar as importações.");

  const batches: BatchSummary[] = data.map((b) => ({
    id: b.id,
    fileName: b.file_name,
    format: b.format,
    status: b.status,
    total: b.rows_total,
    inserted: b.rows_inserted,
    duplicated: b.rows_duplicated,
    error: b.error,
    createdAt: b.created_at,
  }));

  return <ImportPanel targets={toTargets(loaded.accounts, loaded.cards)} categories={loaded.categories} batches={batches} />;
}
