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

export type MappedCapture = {
  externalRef: string;
  description: string;
  /** Negativo é saída, positivo é entrada. */
  amountCents: number;
  date: string;
  method: "pix" | "debit" | "credit" | "boleto" | "transfer" | null;
  reason: string | null;
};

/** Reais em ponto flutuante vindos da API viram centavos pelo texto, sem erro de arredondamento. */
export function reaisToCents(amount: number): number {
  const [whole, fraction = ""] = Math.abs(amount).toFixed(2).split(".");
  return Number(whole) * 100 + Number(fraction);
}

function bankMethod(tx: PluggyTransaction): MappedCapture["method"] {
  const text = `${tx.operationType ?? ""} ${tx.description}`.toUpperCase();
  if (text.includes("PIX")) return "pix";
  if (text.includes("BOLETO")) return "boleto";
  if (text.includes("TED") || text.includes("DOC ") || text.includes("TRANSFERENCIA")) return "transfer";
  if (text.includes("CARTAO") || text.includes("CARTÃO") || text.includes("DEBITO")) return "debit";
  return null;
}

/**
 * Traduz uma transação da Pluggy em um evento de captura, ou null para ignorar.
 *
 * Conta: só o que já foi efetivado; agendado ou bloqueado ainda não aconteceu.
 * Cartão: compras em aberto e parcelas futuras vêm como PENDING e são justamente o que
 * consome o limite, então entram, cada uma na fatura do seu mês. Pagamento da fatura no
 * cartão é ignorado, pois o lado que vale é a saída da conta.
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

  if (accountType === "CREDIT") {
    if (tx.amount < 0) {
      if (tx.operationType === "PAGAMENTO_FATURA") return null;
      return {
        externalRef,
        description: name,
        amountCents: cents,
        date,
        method: "credit",
        reason: "Estorno ou crédito no cartão",
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
      reason: null,
    };
  }

  if (tx.status === "PENDING" || date > today) return null;

  // Na conta, quem define o sentido é `type`; o sinal de `amount` só vale sem ele.
  const isIncome = tx.type ? tx.type === "CREDIT" : tx.amount > 0;
  let reason: string | null = null;
  if (tx.operationType === "PAGAMENTO_FATURA") {
    reason = "Pagamento de fatura: registre na fatura do cartão e descarte aqui";
  } else if (tx.operationType === "TRANSFERENCIA_MESMA_INSTITUICAO") {
    reason = "Possível transferência entre suas contas";
  }

  return {
    externalRef,
    description: name,
    amountCents: isIncome ? cents : -cents,
    date,
    method: bankMethod(tx),
    reason,
  };
}
