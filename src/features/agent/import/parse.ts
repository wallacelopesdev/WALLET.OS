import { parseCsv } from "./csv";
import { decodeStatement } from "./decode";
import { looksLikeOfx, parseOfx } from "./ofx";
import { MAX_IMPORT_BYTES, type ParseResult } from "./types";

/** O formato vem do conteúdo. A extensão só serve para recusar o que claramente não é extrato. */
export function parseStatement(name: string, bytes: Uint8Array): ParseResult {
  if (bytes.length > MAX_IMPORT_BYTES) {
    return { ok: false, error: "O arquivo tem mais de 5 MB." };
  }
  if (!/\.(ofx|qfx|csv|txt)$/i.test(name)) {
    return { ok: false, error: "Envie um arquivo OFX ou CSV." };
  }

  const text = decodeStatement(bytes);
  if (text === null) return { ok: false, error: "O conteúdo do arquivo não é um extrato em texto." };

  if (looksLikeOfx(text)) return parseOfx(text);
  if (/\.(ofx|qfx)$/i.test(name)) {
    return { ok: false, error: "O arquivo não tem a estrutura de um extrato OFX." };
  }
  return parseCsv(text);
}
