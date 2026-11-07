export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;

export type ParsedRow = {
  /** Identificador estável: o do banco, quando há, ou um calculado a partir do conteúdo. */
  ref: string;
  date: string;
  description: string;
  /** Negativo é saída, positivo é entrada. */
  amountCents: number;
};

export type ParseResult =
  | { ok: true; format: "ofx" | "csv"; rows: ParsedRow[]; skipped: number }
  | { ok: false; error: string };

/**
 * A mesma linha pode aparecer duas vezes de verdade em um extrato sem identificadores
 * (dois cafés iguais no mesmo dia). O número da ocorrência mantém as duas e ainda assim
 * reconhece a reimportação do mesmo arquivo.
 */
export function contentRefs(rows: Omit<ParsedRow, "ref">[], prefix: string): ParsedRow[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = `${row.date}|${row.amountCents}|${row.description.trim().toLowerCase().replace(/\s+/g, " ")}`;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return { ...row, ref: `${prefix}:${key}|${occurrence}` };
  });
}
