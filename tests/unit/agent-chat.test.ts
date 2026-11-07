import { describe, expect, it } from "vitest";
import { during } from "@/features/agent/chat/answers";
import { parsePeriod, parseQuestion, totalExpenses, totalIncome } from "@/features/agent/chat/intents";

const TODAY = "2026-11-05"; // quinta-feira

const CATEGORIES = [
  { id: "c1", name: "Alimentação", kind: "expense", archived: false },
  { id: "c2", name: "Mercado", kind: "expense", archived: false },
  { id: "c3", name: "Salário", kind: "income", archived: false },
];

const intentOf = (question: string) => parseQuestion(question, CATEGORIES, TODAY).intent;

describe("perguntas previstas", () => {
  it.each([
    ["Quanto gastei hoje?", "spent"],
    ["Quanto gastei com alimentação neste mês?", "spent"],
    ["Quais foram minhas maiores despesas?", "top_expenses"],
    ["Qual foi minha maior despesa?", "top_expenses"],
    ["Quanto tenho de fatura para pagar?", "invoices"],
    ["Quais boletos vencem esta semana?", "bills"],
    ["Quanto recebi por Pix?", "pix_received"],
    ["Quanto transferi para outras pessoas?", "sent_to_others"],
    ["Quais assinaturas estão cobrando mensalmente?", "subscriptions"],
    ["Quanto posso gastar até o fim do mês?", "can_spend"],
    ["Como está minha situação financeira?", "situation"],
    ["Onde estou gastando mais do que deveria?", "overspending"],
    ["Qual é o meu saldo?", "balance"],
    ["Quanto ganhei em outubro?", "received"],
  ])("%s", (question, intent) => {
    expect(intentOf(question)).toBe(intent);
  });

  it("não inventa uma resposta para o que não entende", () => {
    expect(intentOf("Qual é a capital da França?")).toBe("unknown");
    expect(intentOf("Faça um Pix de 100 reais")).toBe("unknown");
    expect(intentOf("Pague meu cartão")).toBe("unknown");
  });
});

describe("categoria citada na pergunta", () => {
  it("encontra sem acento e sem diferenciar maiúsculas", () => {
    const parsed = parseQuestion("quanto gastei com ALIMENTACAO?", CATEGORIES, TODAY);
    expect(parsed).toMatchObject({ categoryId: "c1", categoryName: "Alimentação" });
  });

  it("só procura categoria do tipo certo", () => {
    expect(parseQuestion("quanto gastei com salário?", CATEGORIES, TODAY)).toMatchObject({ categoryId: null });
    expect(parseQuestion("quanto recebi de salário?", CATEGORIES, TODAY)).toMatchObject({ categoryId: "c3" });
  });

  it("nome de categoria com caractere especial não quebra a busca", () => {
    const tricky = [{ id: "x", name: "Lazer (C++)", kind: "expense", archived: false }];
    expect(parseQuestion("quanto gastei com lazer (c++)?", tricky, TODAY).intent).toBe("spent");
  });
});

describe("período", () => {
  it("sem período explícito, vale o mês atual até hoje", () => {
    expect(parsePeriod("quanto gastei", TODAY)).toEqual({ from: "2026-11-01", to: TODAY, label: "este mês" });
  });

  it("hoje e ontem", () => {
    expect(parsePeriod("gastei hoje", TODAY)).toMatchObject({ from: TODAY, to: TODAY });
    expect(parsePeriod("gastei ontem", TODAY)).toMatchObject({ from: "2026-11-04", to: "2026-11-04" });
  });

  it("semana começa na segunda", () => {
    expect(parsePeriod("nesta semana", TODAY)).toMatchObject({ from: "2026-11-02", to: TODAY });
    expect(parsePeriod("semana passada", TODAY)).toMatchObject({ from: "2026-10-26", to: "2026-11-01" });
  });

  it("mês passado, inclusive na virada do ano", () => {
    expect(parsePeriod("mês passado", TODAY)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(parsePeriod("mês passado", "2027-01-10")).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("mês pelo nome nunca aponta para o futuro", () => {
    expect(parsePeriod("em março", TODAY)).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
    expect(parsePeriod("em dezembro", TODAY)).toMatchObject({ from: "2025-12-01", label: "dezembro de 2025" });
    expect(parsePeriod("em dezembro de 2024", TODAY)).toMatchObject({ from: "2024-12-01" });
  });

  it("últimos N dias incluem hoje", () => {
    expect(parsePeriod("últimos 7 dias", TODAY)).toMatchObject({ from: "2026-10-30", to: TODAY });
  });
});

describe("período na frase", () => {
  it.each([
    ["gastei hoje", "hoje"],
    ["neste mês", "este mês"],
    ["mês passado", "no mês passado"],
    ["semana passada", "na semana passada"],
    ["últimos 7 dias", "nos últimos 7 dias"],
    ["em março", "em março de 2026"],
  ])("%s", (question, expected) => {
    expect(during(parsePeriod(question, TODAY))).toBe(expected);
  });
});

describe("totais", () => {
  const rows = [
    { amountCents: -5000, kind: "expense" },
    { amountCents: -2000, kind: "expense" },
    { amountCents: 1000, kind: "refund" },
    { amountCents: -30000, kind: "transfer" },
    { amountCents: 30000, kind: "transfer" },
    { amountCents: -8000, kind: "invoice_payment" },
    { amountCents: 100000, kind: "income" },
  ];

  it("transferência própria e pagamento de fatura não são despesa", () => {
    expect(totalExpenses(rows)).toBe(6000);
  });

  it("transferência própria e estorno não são receita", () => {
    expect(totalIncome(rows)).toBe(100000);
  });

  it("estorno maior que as despesas do período não dá gasto negativo", () => {
    expect(totalExpenses([{ amountCents: 900, kind: "refund" }])).toBe(0);
  });
});
