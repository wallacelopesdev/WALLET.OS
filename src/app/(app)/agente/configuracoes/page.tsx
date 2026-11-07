import { MigrationNotice } from "@/components/migration-notice";
import { Card, CardTitle } from "@/components/ui/card";
import { RulesList } from "@/features/agent/components/recurring-list";
import { SettingsForm } from "@/features/agent/components/settings-form";
import { getSettings, listRules } from "@/features/agent/queries";
import { listCategories } from "@/features/categories/queries";
import { MigrationRequiredError } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function AgentSettingsPage() {
  if (!isSupabaseConfigured()) return null;

  let loaded;
  try {
    const [settings, rules, categories] = await Promise.all([getSettings(), listRules(), listCategories()]);
    loaded = { settings, rules, categories };
  } catch (error) {
    if (error instanceof MigrationRequiredError) return <MigrationNotice file="0008_agent_core.sql" />;
    throw error;
  }

  const names = Object.fromEntries(loaded.categories.map((c) => [c.id, c.name]));

  return (
    <>
      <SettingsForm settings={loaded.settings} />
      <Card className="mt-3 animate-rise">
        <CardTitle>O que o agente aprendeu com você</CardTitle>
        {loaded.rules.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            Quando você corrige a categoria de um lançamento, a correção vira uma regra e aparece aqui.
          </p>
        ) : (
          <RulesList rules={loaded.rules} categoryNames={names} />
        )}
      </Card>
    </>
  );
}
