import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MigrationNotice } from "@/components/migration-notice";
import { PageHeader } from "@/components/ui/card";
import { CategoryManager } from "@/features/categories/components/category-manager";
import { FinanceTabs } from "@/features/categories/components/finance-tabs";
import {
  listCategoriesWithTotals,
  type CategoryWithTotals,
} from "@/features/categories/queries";
import { MigrationRequiredError } from "@/lib/action-result";
import {
  addMonths,
  formatMonth,
  isValidISOMonth,
  todayInSaoPaulo,
} from "@/lib/dates";
import { isSupabaseConfigured } from "@/lib/env";

export const metadata: Metadata = { title: "Categorias" };
export const dynamic = "force-dynamic";

const navClass =
  "flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors hover:bg-raised hover:text-fg active:bg-raised";

export default async function CategoriasPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const { mes } = await searchParams;
  const demo = !isSupabaseConfigured();
  const month = mes && isValidISOMonth(mes) ? mes : todayInSaoPaulo().slice(0, 7);
  const subtitle = "Organize seus lançamentos e veja quanto passa por cada categoria.";

  let categories: CategoryWithTotals[];
  try {
    categories = await listCategoriesWithTotals(month);
  } catch (error) {
    if (error instanceof MigrationRequiredError) {
      return (
        <>
          <PageHeader title="Financeiro" subtitle={subtitle} />
          <FinanceTabs active="categorias" />
          <MigrationNotice file="0003_categories.sql" />
        </>
      );
    }
    throw error;
  }

  return (
    <>
      <PageHeader
        title="Financeiro"
        subtitle={subtitle}
        badge={demo ? "Dados fictícios" : undefined}
      />
      <FinanceTabs active="categorias" />

      <div className="mb-3 flex animate-rise items-center justify-between gap-2">
        <Link
          href={`/financeiro/categorias?mes=${addMonths(month, -1)}`}
          aria-label="Mês anterior"
          className={navClass}
        >
          <ChevronLeft aria-hidden className="h-5 w-5" />
        </Link>
        <p className="text-sm font-medium">{formatMonth(month)}</p>
        <Link
          href={`/financeiro/categorias?mes=${addMonths(month, 1)}`}
          aria-label="Próximo mês"
          className={navClass}
        >
          <ChevronRight aria-hidden className="h-5 w-5" />
        </Link>
      </div>

      <CategoryManager categories={categories} readOnly={demo} />
    </>
  );
}
