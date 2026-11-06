/** Tipos que podem ser criados pela tela. Pagamento de fatura chega no módulo de Faturas. */
export const EDITABLE_KINDS = ["expense", "income", "transfer"] as const;
export type EditableKind = (typeof EDITABLE_KINDS)[number];

export const FILTERABLE_KINDS = ["income", "expense", "transfer", "invoice_payment"] as const;
export type FilterableKind = (typeof FILTERABLE_KINDS)[number];

export const KIND_LABELS: Record<string, string> = {
  income: "Receita",
  expense: "Despesa",
  transfer: "Transferência",
  invoice_payment: "Pagamento de fatura",
  refund: "Estorno",
  other: "Outros",
};

export const PAYMENT_METHODS = [
  "pix",
  "cash",
  "debit",
  "credit",
  "boleto",
  "transfer",
  "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  pix: "PIX",
  cash: "Dinheiro",
  debit: "Débito",
  credit: "Crédito",
  boleto: "Boleto",
  transfer: "Transferência",
  other: "Outros",
};

export const SORTS = ["data_desc", "data_asc", "valor_desc", "valor_asc"] as const;
export type Sort = (typeof SORTS)[number];

export const SORT_LABELS: Record<Sort, string> = {
  data_desc: "Mais recentes",
  data_asc: "Mais antigas",
  valor_desc: "Maior valor",
  valor_asc: "Menor valor",
};

export const TRANSACTIONS_PAGE_SIZE = 30;

export const DEFAULT_TRANSFER_DESCRIPTION = "Transferência";
