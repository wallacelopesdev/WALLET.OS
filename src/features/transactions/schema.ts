import { z } from "zod";
import { isValidISODate, todayInSaoPaulo } from "@/lib/dates";
import { parseBRLToCents } from "@/lib/money";
import {
  DEFAULT_TRANSFER_DESCRIPTION,
  FILTERABLE_KINDS,
  PAYMENT_METHODS,
  SORTS,
  type FilterableKind,
  type Sort,
} from "./constants";

export const transactionIdSchema = z.string().uuid();

const MIN_DATE = "2000-01-01";

const positiveAmount = z.string().transform((value, ctx) => {
  const cents = parseBRLToCents(value);
  if (cents === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Informe um valor válido, como 1.234,56.",
    });
    return z.NEVER;
  }
  if (cents <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Informe um valor maior que zero.",
    });
    return z.NEVER;
  }
  return cents;
});

const realDate = z
  .string()
  .refine(isValidISODate, "Informe uma data válida.")
  .refine((date) => date >= MIN_DATE, "A data é antiga demais.");

/**
 * Todo lançamento já está efetivado e conta no saldo, por isso a data da
 * movimentação não pode estar no futuro.
 */
const movementDate = realDate.refine(
  (date) => date <= todayInSaoPaulo(),
  "A data não pode estar no futuro.",
);

const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .transform((value) => value || null);

const notes = optionalText(1000, "Use no máximo 1.000 caracteres.");

const requestId = z.string().uuid("Requisição inválida. Recarregue a página.");
const accountId = z.string().uuid("Selecione uma conta.");

export const transactionFormSchema = z.object({
  requestId,
  kind: z.enum(["income", "expense"], {
    errorMap: () => ({ message: "Selecione o tipo." }),
  }),
  description: z
    .string()
    .trim()
    .min(1, "Informe uma descrição.")
    .max(200, "Use no máximo 200 caracteres."),
  amount: positiveAmount,
  accountId,
  categoryId: z.union([z.literal(""), z.string().uuid("Categoria inválida.")]),
  postedAt: movementDate,
  competenceDate: z.union([z.literal(""), realDate]),
  paymentMethod: z.union([
    z.literal(""),
    z.enum(PAYMENT_METHODS, { errorMap: () => ({ message: "Método inválido." }) }),
  ]),
  notes,
});

export type TransactionInput = z.output<typeof transactionFormSchema>;

/** Dados do banco: saída é negativa, entrada é positiva. */
export function toTransactionRow(input: TransactionInput) {
  return {
    kind: input.kind,
    description: input.description,
    amount_cents: input.kind === "expense" ? -input.amount : input.amount,
    account_id: input.accountId,
    category_id: input.categoryId || null,
    category_source: input.categoryId ? ("manual" as const) : null,
    posted_at: input.postedAt,
    competence_date: input.competenceDate || null,
    payment_method: input.paymentMethod || null,
    notes: input.notes,
  };
}

export const transferFormSchema = z
  .object({
    requestId,
    fromAccountId: z.string().uuid("Selecione a conta de origem."),
    toAccountId: z.string().uuid("Selecione a conta de destino."),
    amount: positiveAmount,
    postedAt: movementDate,
    description: z
      .string()
      .trim()
      .max(200, "Use no máximo 200 caracteres.")
      .transform((value) => value || DEFAULT_TRANSFER_DESCRIPTION),
    notes,
  })
  .superRefine((data, ctx) => {
    if (data.fromAccountId === data.toAccountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toAccountId"],
        message: "Escolha uma conta diferente da origem.",
      });
    }
  });

export type TransferInput = z.output<typeof transferFormSchema>;

export type TransactionFilters = {
  q: string;
  kind: FilterableKind | null;
  categoryId: string | null;
  accountId: string | null;
  from: string | null;
  to: string | null;
  sort: Sort;
  page: number;
};

type RawParams = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : "";

const uuidOrNull = (value: string) =>
  z.string().uuid().safeParse(value).success ? value : null;

const dateOrNull = (value: string) => (isValidISODate(value) ? value : null);

/**
 * Lê os filtros da URL. Como a URL pode ser editada à mão, valor inválido é
 * ignorado em vez de quebrar a página.
 */
export function parseTransactionFilters(params: RawParams): TransactionFilters {
  const kind = single(params.tipo);
  const sort = single(params.ordem);
  const page = Number(single(params.pagina));
  let from = dateOrNull(single(params.de));
  let to = dateOrNull(single(params.ate));
  if (from && to && from > to) [from, to] = [to, from];

  return {
    q: single(params.q).trim().slice(0, 100),
    kind: (FILTERABLE_KINDS as readonly string[]).includes(kind)
      ? (kind as FilterableKind)
      : null,
    categoryId: uuidOrNull(single(params.categoria)),
    accountId: uuidOrNull(single(params.conta)),
    from,
    to,
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as Sort) : "data_desc",
    page: Number.isInteger(page) && page > 0 && page <= 100_000 ? page : 1,
  };
}

export function hasActiveFilters(f: TransactionFilters): boolean {
  return Boolean(f.q || f.kind || f.categoryId || f.accountId || f.from || f.to);
}

/** Monta a URL mantendo os filtros, para a paginação. */
export function filtersToQuery(f: TransactionFilters, page: number): string {
  const query = new URLSearchParams();
  if (f.q) query.set("q", f.q);
  if (f.kind) query.set("tipo", f.kind);
  if (f.categoryId) query.set("categoria", f.categoryId);
  if (f.accountId) query.set("conta", f.accountId);
  if (f.from) query.set("de", f.from);
  if (f.to) query.set("ate", f.to);
  if (f.sort !== "data_desc") query.set("ordem", f.sort);
  if (page > 1) query.set("pagina", String(page));
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** Impede que `%` e `_` digitados na busca virem curingas do ILIKE. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}
