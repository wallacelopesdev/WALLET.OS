export type FieldErrors = Record<string, string>;

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

export const GENERIC_ERROR = "Não foi possível concluir a operação. Tente novamente.";

export const MIGRATION_REQUIRED_ERROR =
  "O banco de dados está desatualizado. Aplique a migration pendente no Supabase.";

type DbError = { code?: string } | null | undefined;

/** O código está à frente do banco: a tela orienta aplicar a migration. */
export class MigrationRequiredError extends Error {}

/** Coluna, tabela ou função ausente. */
export function isSchemaOutdated(error: DbError): boolean {
  return (
    error?.code === "42703" ||
    error?.code === "42P01" ||
    error?.code === "42883" ||
    error?.code === "PGRST202" ||
    error?.code === "PGRST204" ||
    error?.code === "PGRST205"
  );
}

/** Regras de negócio levantadas pelo banco com SQLSTATE próprio (classe WL). */
const BUSINESS_ERRORS: Record<string, string> = {
  WL001: "A categoria não é compatível com o tipo do lançamento.",
  WL002: "Esta categoria está arquivada. Escolha outra.",
  WL003: "Esta conta está arquivada. Reative-a ou escolha outra.",
  WL004: "O valor não é compatível com o tipo do lançamento.",
  WL005: "A transferência precisa de duas contas diferentes e do mesmo valor nos dois lados.",
  WL006: "Esta categoria já tem lançamentos, então o tipo dela não pode mudar.",
  WL007: "O pagamento é maior que o saldo em aberto desta fatura.",
  WL008: "Uma das faturas desta compra já recebeu pagamento. Desfaça o pagamento antes de excluir.",
  WL009: "Este cartão está arquivado. Reative-o ou escolha outro.",
  WL010: "Este lançamento pertence a um cartão e a uma fatura que não podem ser trocados.",
  WL011: "Um parcelamento precisa ser alterado por inteiro.",
  WL012: "Número de parcelas inválido para este valor.",
  WL013: "Escolha um destino válido para este lançamento.",
  WL014: "Muitas requisições em pouco tempo. Tente de novo em um minuto.",
};

/**
 * Traduz um erro do banco para uma mensagem segura. Nunca repassa `message`,
 * `details` ou `hint`, que revelam nomes de tabelas e constraints.
 */
export function dbErrorMessage(error: DbError, context: string): string {
  console.error(`[${context}] erro de banco, código ${error?.code ?? "desconhecido"}`);

  if (isSchemaOutdated(error)) return MIGRATION_REQUIRED_ERROR;

  const business = error?.code ? BUSINESS_ERRORS[error.code] : undefined;
  if (business) return business;

  switch (error?.code) {
    case "23503":
      return "Este registro está vinculado a outros dados e não pode ser removido.";
    case "23505":
      return "Já existe um registro igual a este.";
    case "23514":
      return "Os dados informados não são válidos.";
    case "42501":
      return "Você não tem permissão para esta operação.";
    default:
      return GENERIC_ERROR;
  }
}
