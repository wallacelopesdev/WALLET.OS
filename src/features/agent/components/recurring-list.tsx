"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { formatBRL, formatDateFull } from "@/lib/utils";
import { dismissRecurring, markNotificationsRead, removeCategoryRule } from "../actions";
import type { CategoryRule, RecurringCharge } from "../queries";

export function RecurringList({ items }: { items: RecurringCharge[] }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <ul className="mt-2 divide-y divide-line">
      {items.map((item) => (
        <li key={item.id} className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{item.description}</p>
            <p className="text-xs text-faint">
              {item.period === "monthly" ? "Mensal" : "Semanal"} · próxima em {formatDateFull(item.nextDate)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="text-sm tabular-nums">{formatBRL(item.amountCents)}</span>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await dismissRecurring(item.id);
                  if (result.ok) toast.success(result.message);
                  else toast.error(result.error);
                })
              }
            >
              Dispensar
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MarkAllRead() {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await markNotificationsRead();
          if (result.ok) toast.success(result.message);
          else toast.error(result.error);
        })
      }
    >
      Marcar como lidos
    </Button>
  );
}

export function RulesList({
  rules,
  categoryNames,
}: {
  rules: CategoryRule[];
  categoryNames: Record<string, string>;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <ul className="mt-2 divide-y divide-line">
      {rules.map((rule) => (
        <li key={rule.id} className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{rule.pattern}</p>
            <p className="text-xs text-faint">{categoryNames[rule.categoryId] ?? "Categoria"}</p>
          </div>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await removeCategoryRule(rule.id);
                if (result.ok) toast.success(result.message);
                else toast.error(result.error);
              })
            }
          >
            Remover
          </Button>
        </li>
      ))}
    </ul>
  );
}
