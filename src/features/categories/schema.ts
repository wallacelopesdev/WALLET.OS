import { z } from "zod";
import {
  CATEGORY_COLORS,
  CATEGORY_ICON_NAMES,
  CATEGORY_KINDS,
  type CategoryKind,
} from "./constants";

export const categoryIdSchema = z.string().uuid();

export const categoryFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Informe um nome para a categoria.")
    .max(60, "Use no máximo 60 caracteres."),
  kind: z.enum(CATEGORY_KINDS, {
    errorMap: () => ({ message: "Selecione o tipo." }),
  }),
  icon: z.enum(CATEGORY_ICON_NAMES, {
    errorMap: () => ({ message: "Selecione um ícone." }),
  }),
  color: z.enum(CATEGORY_COLORS, {
    errorMap: () => ({ message: "Selecione uma cor." }),
  }),
});

export type CategoryInput = z.output<typeof categoryFormSchema>;

/** `Alimentação Fora` → `alimentacao-fora`. Nome sem letras nem dígitos vira `categoria`. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return slug || "categoria";
}

/** Acrescenta um sufixo numérico até o slug ficar livre. */
export function uniqueSlug(name: string, taken: readonly string[]): string {
  const base = slugify(name);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

type Identity = { id: string; name: string; kind: CategoryKind; archived: boolean };

/** Nome repetido dentro do mesmo tipo, entre as categorias ativas. */
export function findDuplicateCategory(
  candidate: { name: string; kind: CategoryKind },
  existing: readonly Identity[],
  ignoreId?: string,
): Identity | undefined {
  const normalized = candidate.name.trim().toLocaleLowerCase("pt-BR");
  return existing.find(
    (c) =>
      c.id !== ignoreId &&
      !c.archived &&
      c.kind === candidate.kind &&
      c.name.trim().toLocaleLowerCase("pt-BR") === normalized,
  );
}
