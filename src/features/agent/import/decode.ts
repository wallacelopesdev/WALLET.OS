/** Lê bytes de extrato sem presumir a codificação. Bancos brasileiros ainda usam Windows-1252. */
export function decodeStatement(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));

  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const body = bytes.subarray(start);

  // Byte nulo fora de UTF-16: é arquivo binário, seja qual for a extensão.
  if (body.includes(0)) return null;

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}
