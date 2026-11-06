export type FieldErrors = Record<string, string>;

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

export const GENERIC_ERROR = "Não foi possível concluir a operação. Tente novamente.";

export const MIGRATION_REQUIRED_ERROR =
  "O banco de dados está desatualizado. Aplique a migration pendente no Supabase.";

type DbError = { code?: string } | null | undefined;

/** Coluna ou tabela ausente: o código é mais novo que o banco. */
export function isSchemaOutdated(error: DbError): boolean {
  return (
    error?.code === "42703" ||
    error?.code === "42P01" ||
    error?.code === "PGRST204" ||
    error?.code === "PGRST205"
  );
}

/**
 * Traduz um erro do banco para uma mensagem segura. Nunca repassa `message`,
 * `details` ou `hint`, que revelam nomes de tabelas e constraints.
 */
export function dbErrorMessage(error: DbError, context: string): string {
  console.error(`[${context}] erro de banco, código ${error?.code ?? "desconhecido"}`);

  if (isSchemaOutdated(error)) return MIGRATION_REQUIRED_ERROR;

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
