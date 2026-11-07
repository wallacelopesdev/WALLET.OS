import { isValidISODate } from "@/lib/dates";
import { parseDecimalToCents } from "./csv";
import { MAX_IMPORT_ROWS, contentRefs, type ParseResult, type ParsedRow } from "./types";

function field(block: string, name: string): string {
  // OFX 1.x (SGML) não fecha as tags; OFX 2.x (XML) fecha. Ambos terminam na próxima tag.
  const match = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
  return decodeEntities((match?.[1] ?? "").trim());
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

export function looksLikeOfx(text: string): boolean {
  return /<OFX[\s>]/i.test(text) && /<STMTTRN>|<BANKTRANLIST>|<CCSTMTRS>|<STMTRS>/i.test(text);
}

/** Conteúdo real, não a extensão: precisa ter a estrutura de OFX. */
export function parseOfx(text: string): ParseResult {
  if (!looksLikeOfx(text)) {
    return { ok: false, error: "O arquivo não tem a estrutura de um extrato OFX." };
  }

  const blocks = text.match(/<STMTTRN>[\s\S]*?(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi) ?? [];
  if (blocks.length > MAX_IMPORT_ROWS) {
    return { ok: false, error: `O arquivo tem mais de ${MAX_IMPORT_ROWS} movimentações. Divida-o em partes.` };
  }

  const identified: ParsedRow[] = [];
  const anonymous: Omit<ParsedRow, "ref">[] = [];
  let skipped = 0;

  for (const block of blocks) {
    const rawDate = field(block, "DTPOSTED").slice(0, 8);
    const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
    const cents = parseDecimalToCents(field(block, "TRNAMT"));
    const description = (field(block, "MEMO") || field(block, "NAME") || field(block, "PAYEE")).replace(/\s+/g, " ");

    if (!isValidISODate(date) || cents === null || cents === 0 || !description) {
      skipped += 1;
      continue;
    }

    const row = { date, description: description.slice(0, 200), amountCents: cents };
    const fitid = field(block, "FITID");
    if (fitid) identified.push({ ...row, ref: `ofx:${fitid.slice(0, 120)}` });
    else anonymous.push(row);
  }

  // Alguns bancos repetem FITID: nesse caso o identificador não serve e vale o conteúdo.
  const counts = new Map<string, number>();
  for (const row of identified) counts.set(row.ref, (counts.get(row.ref) ?? 0) + 1);
  const unique = identified.filter((row) => counts.get(row.ref) === 1);
  const repeated = identified.filter((row) => (counts.get(row.ref) ?? 0) > 1);

  const rows = [...unique, ...contentRefs([...repeated, ...anonymous], "ofx-content")].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  if (rows.length === 0) {
    return { ok: false, error: "Nenhuma movimentação encontrada no arquivo." };
  }
  return { ok: true, format: "ofx", rows, skipped };
}
