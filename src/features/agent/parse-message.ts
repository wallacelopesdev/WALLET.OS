import { parseBRLToCents } from "@/lib/money";

export type ParsedMessage = {
  /** Negativo é saída, positivo é entrada. */
  amountCents: number;
  description: string;
  method: "pix" | "debit" | "credit" | "boleto" | null;
  last4: string | null;
  /** Preenchido quando o valor foi lido, mas o sentido não: vai para revisão. */
  reason: string | null;
};

/** Mensagens que nunca podem ser guardadas nem contam como movimentação. */
const SENSITIVE = /c[oó]digo|token|senha|\bverifica|\botp\b/i;

/** Avisos com valor em reais que não são movimentação. */
const NOT_A_MOVEMENT =
  /fatura|limite|vence|venc[ie]mento|oferta|cashback|empr[eé]stimo|parcele|desconto|pr[eé]-aprovad|recusad|negad|n[aã]o autorizad|n[aã]o aprovad|estornad|cancelad|agendad|saldo (dispon|atual)|rendeu|rendimento/i;

const INCOME = /recebeu|recebid[oa]|recebimento|caiu na|dep[oó]sito|cr[eé]dito em conta/i;
const EXPENSE = /compra|enviad[oa]|enviou|pagamento|pagou|transfer[eê]ncia (realizada|efetuada|de)|d[eé]bito|saque|aprovad[oa]/i;

const AMOUNT = /R\$\s*-?\s*(\d[\d.,]*\d|\d)/i;

const STOP = /\s+(?:no valor|(?:(?:no|na|do|com|com o|com seu)\s+)?cart[aã]o|(?:com\s+)?final\s*\d|foi|em \d|[àa]s \d|hoje|ontem|\d{1,2}\/\d{1,2}|\d{1,2}[:h]\d{2})/i;

function extractCounterpart(afterAmount: string, beforeAmount: string): string | null {
  for (const text of [afterAmount, beforeAmount]) {
    const match = /(?:^|\s)(?:para|pra|em|no|na|de|do|da)\s+([^\n,;!]{2,80})/i.exec(text);
    if (!match) continue;
    const name = match[1].split(STOP)[0].replace(/[.\s]+$/, "").trim();
    // Palavras que costumam seguir o "de"/"em" sem ser um nome.
    if (name && !/^(r\$|um |uma |sua |seu |crédito|credito|débito|debito|conta|pix\b)/i.test(name)) {
      return name;
    }
  }
  return null;
}

/**
 * Interpreta o texto de uma notificação, SMS ou e-mail de banco. Devolve null para o
 * que deve ser ignorado sem deixar rastro: mensagens com códigos de segurança, avisos
 * que não são movimentação e textos sem valor em reais.
 */
export function parseBankMessage(raw: string): ParsedMessage | null {
  const text = raw.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length > 2000) return null;
  if (SENSITIVE.test(text) || NOT_A_MOVEMENT.test(text)) return null;

  const amountMatch = AMOUNT.exec(text);
  if (!amountMatch) return null;
  const cents = parseBRLToCents(amountMatch[1]);
  if (cents === null || cents <= 0) return null;

  const isIncome = INCOME.test(text);
  const isExpense = EXPENSE.test(text);

  const method = /\bpix\b/i.test(text)
    ? "pix"
    : /d[eé]bito/i.test(text)
      ? "debit"
      : /cr[eé]dito/i.test(text) && !isIncome
        ? "credit"
        : /boleto/i.test(text)
          ? "boleto"
          : null;

  const last4 = /(?:final|terminado em|\*{2,})\s*(\d{4})\b/i.exec(text)?.[1] ?? null;

  const before = text.slice(0, amountMatch.index);
  const after = text.slice(amountMatch.index + amountMatch[0].length);
  const counterpart = extractCounterpart(after, before);

  const known = isIncome || isExpense;
  const signed = isIncome ? cents : -cents;

  return {
    amountCents: signed,
    description:
      counterpart ??
      (isIncome
        ? method === "pix" ? "Pix recebido" : "Entrada capturada"
        : method === "pix" ? "Pix enviado" : "Compra capturada"),
    method,
    last4,
    reason: known ? null : "Não entendi se foi entrada ou saída",
  };
}
