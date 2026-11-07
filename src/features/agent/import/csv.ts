import { isValidISODate } from "@/lib/dates";
import { MAX_CENTS } from "@/lib/money";
import { MAX_IMPORT_ROWS, contentRefs, type ParseResult } from "./types";

const DELIMITERS = [";", ",", "\t", "|"] as const;

/** Divide uma linha respeitando aspas: `"Mercado; Central";10,00`. */
export function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/** O separador é o que divide as linhas em um número constante de colunas, com mais colunas. */
export function detectDelimiter(lines: string[]): string | null {
  let best: { delimiter: string; columns: number; score: number } | null = null;
  const sample = lines.slice(0, 30);
  for (const delimiter of DELIMITERS) {
    const counts = sample.map((line) => splitLine(line, delimiter).length);
    const columns = Math.max(...counts);
    if (columns < 2) continue;
    const score = counts.filter((count) => count === columns).length;
    if (!best || score > best.score || (score === best.score && columns > best.columns)) {
      best = { delimiter, columns, score };
    }
  }
  return best?.delimiter ?? null;
}

/**
 * Valor decimal nos formatos brasileiro e americano. O último separador é o decimal quando
 * tem 1 ou 2 casas: `1.234,56`, `1,234.56`, `-10.5`, `(10,00)`, `R$ 1.000`.
 */
export function parseDecimalToCents(input: string): number | null {
  let text = input.replace(/[\s ]/g, "").replace(/^R\$/i, "").replace(/R\$/i, "");
  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-") || text.startsWith("+")) {
    negative = negative || text.startsWith("-");
    text = text.slice(1).replace(/^R\$/i, "");
  }
  if (text.endsWith("-")) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (/[DdCc]$/.test(text)) {
    // Extratos antigos: `100,00 D` é débito.
    negative = negative || /[Dd]$/.test(text);
    text = text.slice(0, -1);
  }
  if (!/^\d([\d.,]*\d)?$/.test(text)) return null;

  const decimal = /[.,](\d{1,2})$/.exec(text);
  const fraction = decimal ? decimal[1].padEnd(2, "0") : "00";
  const whole = (decimal ? text.slice(0, decimal.index) : text).replace(/[.,]/g, "");
  if (whole.length > 13) return null;

  const cents = Number(whole || "0") * 100 + Number(fraction);
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  if (cents === 0) return 0;
  return negative ? -cents : cents;
}

/** Datas comuns em extratos. Ano com dois dígitos é deste século. */
export function parseStatementDate(input: string): string | null {
  const text = input.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return isValidISODate(date) ? date : null;
  }
  const br = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s|$)/.exec(text);
  if (br) {
    const year = br[3].length === 2 ? `20${br[3]}` : br[3];
    const date = `${year}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
    return isValidISODate(date) ? date : null;
  }
  return null;
}

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const DATE_HEADERS = /^(data|date|dt|data (do )?(lancamento|movimento|movimentacao|transacao|compra)|lancamento)$/;
const DESCRIPTION_HEADERS = /^(descricao|description|historico|lancamento|memo|titulo|detalhes|estabelecimento|nome|identificador)$/;
const AMOUNT_HEADERS = /^(valor|amount|value|valor \(r\$\)|valor r\$|quantia|montante)$/;
const CREDIT_HEADERS = /^(credito|entrada|entradas|creditos|credito \(r\$\))$/;
const DEBIT_HEADERS = /^(debito|saida|saidas|debitos|debito \(r\$\))$/;

type Columns = { date: number; description: number; amount: number; credit: number; debit: number };

function detectColumns(header: string[]): Columns | null {
  const cells = header.map(normalize);
  const find = (pattern: RegExp, skip = -1) => cells.findIndex((c, i) => i !== skip && pattern.test(c));

  const date = find(DATE_HEADERS);
  if (date === -1) return null;
  const description = find(DESCRIPTION_HEADERS, date);
  const amount = find(AMOUNT_HEADERS);
  const credit = find(CREDIT_HEADERS);
  const debit = find(DEBIT_HEADERS);
  if (description === -1 || (amount === -1 && credit === -1 && debit === -1)) return null;
  return { date, description, amount, credit, debit };
}

/** Procura o cabeçalho nas primeiras linhas: muitos bancos colocam títulos antes dele. */
function findHeader(lines: string[], delimiter: string) {
  for (let i = 0; i < Math.min(lines.length, 25); i += 1) {
    const columns = detectColumns(splitLine(lines[i], delimiter));
    if (columns) return { index: i, columns };
  }
  return null;
}

/** Sem assumir uma estrutura fixa: identifica separador, cabeçalho e colunas pelo conteúdo. */
export function parseCsv(text: string): ParseResult {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim() !== "");
  if (lines.length < 2) return { ok: false, error: "O arquivo não tem movimentações." };
  if (lines.length - 1 > MAX_IMPORT_ROWS) {
    return { ok: false, error: `O arquivo tem mais de ${MAX_IMPORT_ROWS} linhas. Divida-o em partes.` };
  }

  const delimiter = detectDelimiter(lines);
  if (!delimiter) return { ok: false, error: "Não consegui identificar as colunas do arquivo." };

  const header = findHeader(lines, delimiter);
  if (!header) {
    return {
      ok: false,
      error: "Não encontrei as colunas de data, descrição e valor. Confira o cabeçalho do arquivo.",
    };
  }

  const { columns } = header;
  const rows: { date: string; description: string; amountCents: number }[] = [];
  let skipped = 0;

  for (const line of lines.slice(header.index + 1)) {
    const cells = splitLine(line, delimiter);
    const date = parseStatementDate(cells[columns.date] ?? "");
    const description = (cells[columns.description] ?? "").replace(/\s+/g, " ").trim();

    let cents: number | null = null;
    if (columns.amount !== -1 && (cells[columns.amount] ?? "") !== "") {
      cents = parseDecimalToCents(cells[columns.amount]);
    } else {
      const credit = columns.credit !== -1 ? parseDecimalToCents(cells[columns.credit] ?? "") : null;
      const debit = columns.debit !== -1 ? parseDecimalToCents(cells[columns.debit] ?? "") : null;
      if (credit) cents = Math.abs(credit);
      else if (debit) cents = -Math.abs(debit);
    }

    // Linhas de saldo e totais não têm data ou valor: ficam de fora e são contadas.
    if (!date || !description || cents === null || cents === 0 || /^saldo\b/i.test(normalize(description))) {
      skipped += 1;
      continue;
    }
    rows.push({ date, description: description.slice(0, 200), amountCents: cents });
  }

  if (rows.length === 0) return { ok: false, error: "Nenhuma movimentação válida encontrada no arquivo." };
  return { ok: true, format: "csv", rows: contentRefs(rows, "csv"), skipped };
}
