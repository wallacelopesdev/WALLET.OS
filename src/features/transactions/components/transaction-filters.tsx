import Form from "next/form";
import Link from "next/link";
import { Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import type { Account } from "@/features/accounts/queries";
import type { Category } from "@/features/categories/queries";
import {
  FILTERABLE_KINDS,
  KIND_LABELS,
  SORTS,
  SORT_LABELS,
} from "../constants";
import type { TransactionFilters as Filters } from "../schema";

/**
 * Formulário GET: os filtros ficam na URL, então sobrevivem ao recarregar e podem
 * ser compartilhados, e tudo funciona no servidor.
 */
export function TransactionFilters({
  filters,
  accounts,
  categories,
}: {
  filters: Filters;
  accounts: Account[];
  categories: Category[];
}) {
  const advancedCount = [
    filters.kind,
    filters.categoryId,
    filters.accountId,
    filters.from,
    filters.to,
    filters.sort !== "data_desc" ? filters.sort : null,
  ].filter(Boolean).length;
  const hasAny = Boolean(filters.q) || advancedCount > 0;

  return (
    <Form action="/transacoes" key={JSON.stringify(filters)} className="animate-rise">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          />
          <Input
            type="search"
            name="q"
            defaultValue={filters.q}
            aria-label="Pesquisar por descrição"
            placeholder="Pesquisar por descrição"
            maxLength={100}
            className="pl-11"
          />
        </div>
        <Button type="submit" variant="secondary">
          Buscar
        </Button>
      </div>

      {/* Fechado por padrão: com filtro aplicado, o que importa são os resultados. */}
      <details className="relative mt-1">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm text-muted transition-colors hover:text-fg">
          <SlidersHorizontal aria-hidden className="h-4 w-4" />
          Filtros e ordenação{advancedCount > 0 ? ` (${advancedCount})` : ""}
        </summary>
        {hasAny && (
          <Link
            href="/transacoes"
            className="absolute right-0 top-0 flex min-h-11 items-center text-sm text-muted underline underline-offset-4 transition-colors hover:text-fg"
          >
            Limpar
          </Link>
        )}

        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Tipo" htmlFor="filter-kind">
            <Select id="filter-kind" name="tipo" defaultValue={filters.kind ?? ""}>
              <option value="">Todos</option>
              {FILTERABLE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Categoria" htmlFor="filter-category">
            <Select id="filter-category" name="categoria" defaultValue={filters.categoryId ?? ""}>
              <option value="">Todas</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.archived ? " (arquivada)" : ""}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Conta" htmlFor="filter-account">
            <Select id="filter-account" name="conta" defaultValue={filters.accountId ?? ""}>
              <option value="">Todas</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.archived ? " (arquivada)" : ""}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="De" htmlFor="filter-from">
            <Input id="filter-from" type="date" name="de" defaultValue={filters.from ?? ""} />
          </Field>

          <Field label="Até" htmlFor="filter-to">
            <Input id="filter-to" type="date" name="ate" defaultValue={filters.to ?? ""} />
          </Field>

          <Field label="Ordenar por" htmlFor="filter-sort">
            <Select id="filter-sort" name="ordem" defaultValue={filters.sort}>
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {SORT_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Button type="submit" className="mt-3">
          Aplicar filtros
        </Button>
      </details>
    </Form>
  );
}
