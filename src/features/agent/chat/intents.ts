import { addMonths, monthRange } from "@/lib/dates";

export const INTENTS = [
  "spent",
  "received",
  "top_expenses",
  "invoices",
  "bills",
  "pix_received",
  "sent_to_others",
  "subscriptions",
  "can_spend",
  "situation",
  "overspending",
  "balance",
] as const;

export type Intent = (typeof INTENTS)[number];

export type Period = { from: string; to: string; label: string };

export type ParsedQuestion =
  | { intent: Intent; period: Period; categoryId: string | null; categoryName: string | null }
  | { intent: "unknown" };

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const MONTHS = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Lê o período da pergunta. Sem período explícito, vale o mês atual. */
export function parsePeriod(question: string, today: string): Period {
  const text = normalize(question);
  const currentMonth = today.slice(0, 7);

  if (/\bhoje\b/.test(text)) return { from: today, to: today, label: "hoje" };
  if (/\bontem\b/.test(text)) {
    const day = shiftDate(today, -1);
    return { from: day, to: day, label: "ontem" };
  }

  const lastDays = /\bultimos (\d{1,3}) dias\b/.exec(text);
  if (lastDays) {
    return { from: shiftDate(today, -(Number(lastDays[1]) - 1)), to: today, label: `últimos ${lastDays[1]} dias` };
  }

  // Semana começa na segunda-feira.
  const [y, m, d] = today.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  if (/\bsemana passada\b/.test(text)) {
    const start = shiftDate(today, -weekday - 7);
    return { from: start, to: shiftDate(start, 6), label: "semana passada" };
  }
  if (/\b(esta|nesta|essa|nessa) semana\b/.test(text)) {
    return { from: shiftDate(today, -weekday), to: today, label: "esta semana" };
  }

  if (/\bmes passado\b/.test(text)) {
    const month = addMonths(currentMonth, -1);
    return { ...monthRange(month), label: "mês passado" };
  }
  if (/\b(este|neste|esse|nesse) ano\b/.test(text)) {
    return { from: `${y}-01-01`, to: today, label: `${y}` };
  }

  for (const [index, name] of MONTHS.entries()) {
    const match = new RegExp(`\\b(?:em |de )?${name}(?: de (\\d{4}))?\\b`).exec(text);
    if (match) {
      const number = String(index + 1).padStart(2, "0");
      // Sem ano: o mês mais recente com esse nome, nunca no futuro.
      let year = match[1] ? Number(match[1]) : y;
      if (!match[1] && index + 1 > m) year -= 1;
      return { ...monthRange(`${year}-${number}`), label: `${name === "marco" ? "março" : name} de ${year}` };
    }
  }

  return { from: `${currentMonth}-01`, to: today, label: "este mês" };
}

function detectIntent(text: string): Intent | null {
  if (/quanto posso gastar|posso gastar|sobra ate|quanto sobra/.test(text)) return "can_spend";
  if (/gastando mais|gasto a mais|gastando demais|onde .*economizar|mais do que deveria/.test(text)) return "overspending";
  if (/situacao financeira|como (estou|esta|vai) .*(financ|dinheiro|situacao)|minhas financas/.test(text)) return "situation";
  if (/assinatura|cobrando mensal|cobrancas? recorrente|recorrentes?/.test(text)) return "subscriptions";
  if (/boleto/.test(text)) return "bills";
  if (/fatura/.test(text)) return "invoices";
  if (/(recebi|recebido|recebidos|recebeu|entrou).*\bpix\b|\bpix\b.*(recebi|recebido|recebidos)/.test(text)) return "pix_received";
  if (/transferi|enviei|mandei|pix enviado|pix que fiz|para outras pessoas/.test(text)) return "sent_to_others";
  if (/maior(es)? (despesa|gasto|compra)|gastei mais em que|mais caro/.test(text)) return "top_expenses";
  if (/quanto (eu )?(recebi|ganhei|entrou)|minhas? receitas?/.test(text)) return "received";
  if (/gastei|gasto|gastos|despesa|despesas|paguei/.test(text)) return "spent";
  if (/\bsaldo\b|quanto tenho/.test(text)) return "balance";
  return null;
}

/**
 * Interpretador local: entende as perguntas previstas sem enviar nada a ninguém. A palavra
 * "fatura" tem prioridade sobre "pagar", e "quanto gastei com X" procura X nas suas categorias.
 */
export function parseQuestion(
  question: string,
  categories: readonly { id: string; name: string; kind: string; archived: boolean }[],
  today: string,
): ParsedQuestion {
  const text = normalize(question);
  const intent = detectIntent(text);
  if (!intent) return { intent: "unknown" };

  let categoryId: string | null = null;
  let categoryName: string | null = null;
  if (intent === "spent" || intent === "top_expenses" || intent === "received") {
    const kind = intent === "received" ? "income" : "expense";
    const match = [...categories]
      .filter((c) => c.kind === kind)
      .sort((a, b) => b.name.length - a.name.length)
      .find((c) => new RegExp(`\\b${normalize(c.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
    if (match) {
      categoryId = match.id;
      categoryName = match.name;
    }
  }

  return { intent, period: parsePeriod(question, today), categoryId, categoryName };
}

type Row = { amountCents: number; kind: string };

/** Despesas do conjunto: estorno reduz; transferências e pagamentos de fatura não contam. */
export function totalExpenses(rows: readonly Row[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.kind === "transfer" || row.kind === "invoice_payment") continue;
    if (row.kind === "refund") total -= Math.abs(row.amountCents);
    else if (row.amountCents < 0) total += -row.amountCents;
  }
  return Math.max(0, total);
}

export function totalIncome(rows: readonly Row[]): number {
  return rows.reduce(
    (sum, row) =>
      row.amountCents > 0 && row.kind !== "refund" && row.kind !== "transfer" && row.kind !== "invoice_payment"
        ? sum + row.amountCents
        : sum,
    0,
  );
}
