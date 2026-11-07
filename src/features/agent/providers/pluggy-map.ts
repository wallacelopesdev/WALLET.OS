/** Transação como a Pluggy devolve em GET /v2/transactions. */
export type PluggyTransaction = {
  id: string;
  description: string;
  amount: number;
  date: string;
  type?: "DEBIT" | "CREDIT";
  status?: "PENDING" | "POSTED" | null;
  operationType?: string | null;
  merchant?: { name?: string | null; businessName?: string | null } | null;
  creditCardMetadata?: {
    installmentNumber?: number | null;
    totalInstallments?: number | null;
  } | null;
};

export type CaptureIntent = "normal" | "invoice_payment" | "refund" | "possible_transfer";

export type MappedCapture = {
  externalRef: string;
  description: string;
  /** Negativo é saída, positivo é entrada. */
  amountCents: number;
  date: string;
  method: "pix" | "debit" | "credit" | "boleto" | "transfer" | null;
  intent: CaptureIntent;
  reason: string | null;
};

/** Reais em ponto flutuante vindos da API viram centavos pelo texto, sem erro de arredondamento. */
export function reaisToCents(amount: number): number {
  const [whole, fraction = ""] = Math.abs(amount).toFixed(2).split(".");
  return Number(whole) * 100 + Number(fraction);
}

function normalized(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

const INVOICE_PAYMENT =
  /\b(PAG(TO|AMENTO)?\.?\s*(DE\s+|DA\s+)?FATURA|FATURA\s+(DO\s+|DE\s+)?CART|PGTO\s+CART|PAG(TO|AMENTO)?\s+CART(AO)?\s+CRED)/;
const REVERSAL = /\b(DEVOLUCAO|DEVOLVID[OA]|ESTORNO|REVERSAO|REEMBOLSO)\b/;

const METHOD_BY_OPERATION: Record<string, MappedCapture["method"]> = {
  PIX: "pix",
  TED: "transfer",
  DOC: "transfer",
  TRANSFERENCIA_MESMA_INSTITUICAO: "transfer",
  BOLETO: "boleto",
  CONVENIO_ARRECADACAO: "boleto",
  CARTAO: "debit",
};

/** Deduz o que dá para deduzir de uma linha de extrato de conta (OFX e CSV não têm tipos). */
export function inferBankDetails(
  description: string,
  isIncome: boolean,
): { method: MappedCapture["method"]; intent: CaptureIntent } {
  const text = normalized(description);
  let intent: CaptureIntent = "normal";
  if (!isIncome && INVOICE_PAYMENT.test(text)) intent = "invoice_payment";
  else if (isIncome && REVERSAL.test(text)) intent = "refund";
  return { method: bankMethod({ operationType: null }, text), intent };
}

function bankMethod(tx: Pick<PluggyTransaction, "operationType">, text: string): MappedCapture["method"] {
  const byOperation = tx.operationType ? METHOD_BY_OPERATION[tx.operationType] : undefined;
  if (byOperation) return byOperation;
  if (/\bPIX\b/.test(text)) return "pix";
  if (/\bBOLETO\b/.test(text)) return "boleto";
  if (/\b(TED|DOC|TRANSFERENCIA)\b/.test(text)) return "transfer";
  if (/\b(CARTAO|DEBITO)\b/.test(text)) return "debit";
  return null;
}

/**
 * Traduz uma transação da Pluggy em um evento de captura, ou null para ignorar.
 *
 * Conta: só o que já foi efetivado; agendado ou bloqueado ainda não aconteceu. O sentido
 * vem de `type`. O pagamento de fatura é reconhecido pela descrição, porque a Pluggy só
 * usa PAGAMENTO_FATURA do lado do cartão.
 *
 * Cartão: compras em aberto e parcelas futuras vêm como PENDING e consomem o limite, então
 * entram, cada uma na fatura do seu mês. O sinal indica o efeito na dívida: positivo é
 * cobrança. Pagamento recebido é ignorado, pois o lado que vale é a saída da conta.
 */
export function mapPluggyTransaction(
  tx: PluggyTransaction,
  accountType: "BANK" | "CREDIT",
  today: string,
): MappedCapture | null {
  const cents = reaisToCents(tx.amount);
  if (cents === 0) return null;

  const date = tx.date.slice(0, 10);
  const name = (tx.merchant?.name || tx.merchant?.businessName || tx.description || "").trim();
  const externalRef = `pluggy:${tx.id}`;
  const text = normalized(tx.description ?? "");

  if (accountType === "CREDIT") {
    if (tx.amount < 0) {
      if (tx.operationType === "PAGAMENTO" || tx.operationType === "PAGAMENTO_FATURA") return null;
      const isRefund = tx.operationType === "ESTORNO" || tx.operationType === "CASHBACK" || REVERSAL.test(text);
      return {
        externalRef,
        description: name,
        amountCents: cents,
        date,
        method: "credit",
        intent: isRefund ? "refund" : "normal",
        reason: null,
      };
    }
    const number = tx.creditCardMetadata?.installmentNumber;
    const total = tx.creditCardMetadata?.totalInstallments;
    return {
      externalRef,
      description: total && total > 1 && number ? `${name} (${number}/${total})` : name,
      amountCents: -cents,
      date,
      method: "credit",
      intent: "normal",
      reason: null,
    };
  }

  if (tx.status === "PENDING" || date > today) return null;

  const isIncome = tx.type ? tx.type === "CREDIT" : tx.amount > 0;
  let intent: CaptureIntent = "normal";
  if (!isIncome && INVOICE_PAYMENT.test(text)) intent = "invoice_payment";
  else if (isIncome && REVERSAL.test(text)) intent = "refund";
  else if (tx.operationType === "TRANSFERENCIA_MESMA_INSTITUICAO") intent = "possible_transfer";

  return {
    externalRef,
    description: name,
    amountCents: isIncome ? cents : -cents,
    date,
    method: bankMethod(tx, text),
    intent,
    reason: null,
  };
}
