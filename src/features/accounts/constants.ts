export const ACCOUNT_KINDS = [
  "checking",
  "savings",
  "digital",
  "wallet",
  "cash",
  "investment",
  "other",
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  checking: "Conta corrente",
  savings: "Conta poupança",
  digital: "Conta digital",
  wallet: "Carteira física",
  cash: "Dinheiro em espécie",
  investment: "Investimentos",
  other: "Outras",
};

/** Tipos que não têm banco por trás: a instituição é opcional. */
export const KINDS_WITHOUT_INSTITUTION: readonly AccountKind[] = ["wallet", "cash"];

export const INSTITUTION_SUGGESTIONS = [
  "Banco do Brasil",
  "Banco Inter",
  "Bradesco",
  "BTG Pactual",
  "C6 Bank",
  "Caixa Econômica Federal",
  "Itaú",
  "Mercado Pago",
  "Nubank",
  "PagBank",
  "Picpay",
  "Santander",
  "Sicoob",
  "Sicredi",
  "XP Investimentos",
];

export const MOVEMENT_KIND_LABELS: Record<string, string> = {
  pix_in: "PIX recebido",
  pix_out: "PIX enviado",
  debit: "Débito",
  credit: "Crédito",
  transfer: "Transferência",
  invoice_payment: "Pagamento de fatura",
  refund: "Estorno",
  income: "Receita",
  expense: "Despesa",
  other: "Outros",
};

export const MOVEMENTS_PAGE_SIZE = 20;
export const MOVEMENTS_MAX = 500;
