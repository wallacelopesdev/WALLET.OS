/**
 * Conversão de dinheiro sem ponto flutuante: o texto é separado em parte inteira
 * e centavos, e tudo é calculado com inteiros.
 */

/** R$ 1 trilhão em centavos. Igual ao limite da constraint no banco. */
export const MAX_CENTS = 100_000_000_000_000;

const WITH_COMMA = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{1,2})$/;
const THOUSANDS_ONLY = /^\d{1,3}(?:\.\d{3})+$/;
const DOT_DECIMAL = /^(\d+)\.(\d{1,2})$/;
const INTEGER = /^\d+$/;

/**
 * Converte um valor digitado em centavos, ou null se for inválido.
 * Aceita `1.234,56`, `1234,56`, `1234`, `1.234` (milhar), `12.50`, `R$ 10,00`, `-50`.
 * Rejeita mais de 2 casas decimais, agrupamentos errados e valores fora do limite.
 */
export function parseBRLToCents(input: string): number | null {
  let text = input.replace(/[\s ]/g, "");

  const negative = text.startsWith("-");
  if (negative) text = text.slice(1);
  text = text.replace(/^R\$/i, "");

  let whole: string;
  let fraction = "";

  const comma = WITH_COMMA.exec(text);
  const dot = DOT_DECIMAL.exec(text);
  if (comma) {
    whole = comma[1].replaceAll(".", "");
    fraction = comma[2];
  } else if (THOUSANDS_ONLY.test(text)) {
    whole = text.replaceAll(".", "");
  } else if (dot) {
    whole = dot[1];
    fraction = dot[2];
  } else if (INTEGER.test(text)) {
    whole = text;
  } else {
    return null;
  }

  // Evita perder precisão antes da checagem de limite.
  const digits = whole.replace(/^0+(?=\d)/, "");
  if (digits.length > 13) return null;

  const cents = Number(digits) * 100 + Number(fraction.padEnd(2, "0"));
  if (cents > MAX_CENTS) return null;
  if (cents === 0) return 0;
  return negative ? -cents : cents;
}

/** Centavos para o formato de edição, sem símbolo: `1.234,56`. */
export function centsToInput(cents: number): string {
  const abs = Math.abs(cents);
  const whole = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+$)/g, ".");
  const fraction = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${whole},${fraction}`;
}
