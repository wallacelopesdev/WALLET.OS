"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, fieldAria } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/utils";
import { createCategory, updateCategory } from "../actions";
import {
  CATEGORY_COLORS,
  CATEGORY_ICON_NAMES,
  CATEGORY_KINDS,
  CATEGORY_KIND_LABELS,
  DEFAULT_CATEGORY_COLOR,
  DEFAULT_CATEGORY_ICON,
  type CategoryIconName,
  type CategoryKind,
} from "../constants";
import type { CategoryWithTotals } from "../queries";
import { CATEGORY_ICONS } from "./category-icon";

export function CategoryForm({
  category,
  defaultKind = "expense",
  onDone,
}: {
  category?: CategoryWithTotals;
  defaultKind?: CategoryKind;
  onDone: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(category?.name ?? "");
  const [kind, setKind] = useState<CategoryKind>(category?.kind ?? defaultKind);
  const [icon, setIcon] = useState<string>(category?.icon ?? DEFAULT_CATEGORY_ICON);
  const [color, setColor] = useState<string>(category?.color ?? DEFAULT_CATEGORY_COLOR);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      const result = category
        ? await updateCategory(category.id, previous, formData)
        : await createCategory(previous, formData);
      if (result.ok) {
        toast.success(result.message);
        onDone();
      }
      return result;
    },
    null,
  );

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok ? state.error : null;
  const kindLocked = (category?.totalCount ?? 0) > 0;

  return (
    <form action={action} className="space-y-4" noValidate>
      <Field label="Nome" htmlFor="category-name" error={errors.name}>
        <Input
          {...fieldAria("category-name", errors.name)}
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Viagens"
          maxLength={60}
          autoComplete="off"
          required
        />
      </Field>

      <Field
        label="Tipo"
        htmlFor="category-kind"
        error={errors.kind}
        hint={kindLocked ? "O tipo não muda porque esta categoria já tem lançamentos." : undefined}
      >
        <Select
          {...fieldAria("category-kind", errors.kind)}
          value={kind}
          onChange={(e) => setKind(e.target.value as CategoryKind)}
          disabled={kindLocked}
          className="disabled:text-muted"
        >
          {CATEGORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {CATEGORY_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
        {/* Campo desabilitado não é enviado no formulário. */}
        <input type="hidden" name="kind" value={kind} />
      </Field>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Ícone</legend>
        <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-9">
          {CATEGORY_ICON_NAMES.map((iconName) => {
            const Icon = CATEGORY_ICONS[iconName as CategoryIconName];
            const selected = icon === iconName;
            return (
              <button
                key={iconName}
                type="button"
                onClick={() => setIcon(iconName)}
                aria-pressed={selected}
                aria-label={`Ícone ${iconName}`}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-lg border transition-colors",
                  selected
                    ? "border-fg bg-raised text-fg"
                    : "border-line text-muted hover:bg-raised hover:text-fg",
                )}
              >
                <Icon aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </button>
            );
          })}
        </div>
        <input type="hidden" name="icon" value={icon} />
        {errors.icon && <p role="alert" className="mt-1.5 text-sm">{errors.icon}</p>}
      </fieldset>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Cor</legend>
        <div className="grid grid-cols-5 gap-1 sm:grid-cols-10">
          {CATEGORY_COLORS.map((c) => {
            const selected = color === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-pressed={selected}
                aria-label={`Cor ${c}`}
                className={cn(
                  "flex aspect-square min-h-11 items-center justify-center rounded-full border transition-colors sm:min-h-0",
                  selected ? "border-fg" : "border-transparent hover:border-line-strong",
                )}
              >
                <span className="h-6 w-6 rounded-full" style={{ backgroundColor: c }} />
              </button>
            );
          })}
        </div>
        <input type="hidden" name="color" value={color} />
        {errors.color && <p role="alert" className="mt-1.5 text-sm">{errors.color}</p>}
      </fieldset>

      {formError && (
        <p role="alert" className="rounded-xl border border-line-strong bg-raised px-4 py-3 text-sm">
          {formError}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
        <Button variant="secondary" onClick={onDone} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Salvando…" : category ? "Salvar alterações" : "Criar categoria"}
        </Button>
      </div>
    </form>
  );
}
