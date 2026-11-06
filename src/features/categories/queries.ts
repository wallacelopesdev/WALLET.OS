import { MigrationRequiredError, isSchemaOutdated } from "@/lib/action-result";
import { monthRange } from "@/lib/dates";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { CategoryKind } from "./constants";

export type Category = {
  id: string;
  name: string;
  kind: CategoryKind;
  icon: string | null;
  color: string | null;
  isSystem: boolean;
  archived: boolean;
};

export type CategoryWithTotals = Category & {
  /** Sempre positivo: despesas e receitas aparecem pelo valor movimentado. */
  periodCents: number;
  periodCount: number;
  totalCount: number;
};

type CategoryRow = {
  id: string;
  name: string;
  kind: CategoryKind;
  icon: string | null;
  color: string | null;
  is_system: boolean;
  archived: boolean;
};

type TotalsRow = {
  category_id: string;
  period_cents: number;
  period_count: number;
  total_count: number;
};

function fail(error: { code?: string }, context: string): never {
  if (isSchemaOutdated(error)) throw new MigrationRequiredError();
  console.error(`[${context}] erro de banco, código ${error.code ?? "desconhecido"}`);
  throw new Error("Falha ao carregar os dados.");
}

export async function listCategories(): Promise<Category[]> {
  if (!isSupabaseConfigured()) {
    const { demoCategories } = await import("@/lib/demo-data");
    return demoCategories();
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("transaction_categories")
    .select("id,name,kind,icon,color,is_system,archived")
    .order("name");

  if (error) fail(error, "listCategories");

  return (data as CategoryRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    icon: r.icon,
    color: r.color,
    isSystem: r.is_system,
    archived: r.archived,
  }));
}

export async function listCategoriesWithTotals(month: string): Promise<CategoryWithTotals[]> {
  const categories = await listCategories();

  if (!isSupabaseConfigured()) {
    const { demoCategoryTotals } = await import("@/lib/demo-data");
    return categories.map((c) => ({ ...c, ...demoCategoryTotals(c.id) }));
  }

  const { from, to } = monthRange(month);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("category_totals", {
    p_from: from,
    p_to: to,
  });

  if (error) fail(error, "category_totals");

  const totals = new Map((data as TotalsRow[]).map((r) => [r.category_id, r]));

  return categories.map((c) => {
    const row = totals.get(c.id);
    return {
      ...c,
      periodCents: Math.abs(Number(row?.period_cents ?? 0)),
      periodCount: Number(row?.period_count ?? 0),
      totalCount: Number(row?.total_count ?? 0),
    };
  });
}
