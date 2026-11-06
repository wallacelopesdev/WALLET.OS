import { describe, expect, it } from "vitest";
import {
  cardFormSchema,
  paymentFormSchema,
  purchaseFormSchema,
} from "@/features/cards/schema";
import {
  groupInvoices,
  invoiceStatus,
  nextInvoiceToPay,
  remainingCents,
  usedLimitCents,
} from "@/features/cards/status";
import { todayInSaoPaulo } from "@/lib/dates";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const validCard = {
  name: "Nubank",
  institution: "Nubank",
  last4: "1234",
  limit: "5.000,00",
  closingDay: "10",
  dueDay: "20",
};

describe("cardFormSchema", () => {
  it("converte para os campos do banco, com limite em centavos", () => {
    expect(cardFormSchema.parse(validCard)).toEqual({
      name: "Nubank",
      institution: "Nubank",
      last4: "1234",
      limit_cents: 500000,
      closing_day: 10,
      due_day: 20,
    });
  });

  it("últimos dígitos são opcionais", () => {
    expect(cardFormSchema.parse({ ...validCard, last4: "" }).last4).toBeNull();
  });

  it.each(["123", "12345", "abcd", "4111111111111111", "4111 1111 1111 1111"])(
    "nunca aceita %j como últimos dígitos",
    (last4) => {
      expect(cardFormSchema.safeParse({ ...validCard, last4 }).success).toBe(false);
    },
  );

  it("descarta dados sensíveis enviados a mais", () => {
    const parsed = cardFormSchema.parse({ ...validCard, cvv: "123", number: "4111111111111111" });
    expect(parsed).not.toHaveProperty("cvv");
    expect(parsed).not.toHaveProperty("number");
  });

  it.each(["0", "32", "-1", "1.5", "abc", ""])("rejeita o dia %j", (closingDay) => {
    expect(cardFormSchema.safeParse({ ...validCard, closingDay }).success).toBe(false);
  });

  it("aceita limite zero e rejeita negativo", () => {
    expect(cardFormSchema.safeParse({ ...validCard, limit: "0" }).success).toBe(true);
    expect(cardFormSchema.safeParse({ ...validCard, limit: "-1,00" }).success).toBe(false);
  });
});

describe("purchaseFormSchema", () => {
  const valid = {
    requestId: UUID,
    cardId: UUID,
    description: "Mercado",
    amount: "100,00",
    installments: "3",
    postedAt: "2026-01-15",
    categoryId: "",
    notes: "",
  };

  it("converte valor e parcelas", () => {
    const parsed = purchaseFormSchema.parse(valid);
    expect(parsed.amount).toBe(10000);
    expect(parsed.installments).toBe(3);
    expect(parsed.categoryId).toBeNull();
  });

  it.each(["0", "49", "1.5", "abc"])("rejeita %j parcelas", (installments) => {
    expect(purchaseFormSchema.safeParse({ ...valid, installments }).success).toBe(false);
  });

  it("rejeita parcela abaixo de um centavo", () => {
    expect(purchaseFormSchema.safeParse({ ...valid, amount: "0,02" }).success).toBe(false);
  });

  it("rejeita data futura", () => {
    const tomorrow = todayInSaoPaulo(new Date(Date.now() + 86_400_000));
    expect(purchaseFormSchema.safeParse({ ...valid, postedAt: tomorrow }).success).toBe(false);
  });
});

describe("paymentFormSchema", () => {
  it("exige valor positivo", () => {
    const base = { requestId: UUID, invoiceId: UUID, accountId: UUID, paidAt: "2026-01-15" };
    expect(paymentFormSchema.safeParse({ ...base, amount: "10,00" }).success).toBe(true);
    expect(paymentFormSchema.safeParse({ ...base, amount: "0" }).success).toBe(false);
    expect(paymentFormSchema.safeParse({ ...base, amount: "-1" }).success).toBe(false);
  });
});

describe("invoiceStatus", () => {
  const invoice = {
    totalCents: 1000,
    paidCents: 0,
    closingDate: "2026-11-10",
    dueDate: "2026-11-20",
  };

  it.each([
    ["aberta antes do fechamento", "2026-11-09", "open"],
    ["fechada no dia do fechamento", "2026-11-10", "closed"],
    ["fechada até o vencimento", "2026-11-20", "closed"],
    ["atrasada no dia seguinte ao vencimento", "2026-11-21", "overdue"],
  ])("%s", (_label, today, expected) => {
    expect(invoiceStatus(invoice, today)).toBe(expected);
  });

  it("paga tem prioridade, mesmo depois do vencimento", () => {
    expect(invoiceStatus({ ...invoice, paidCents: 1000 }, "2027-01-01")).toBe("paid");
  });

  it("parcialmente paga e vencida continua atrasada", () => {
    expect(invoiceStatus({ ...invoice, paidCents: 999 }, "2026-11-21")).toBe("overdue");
  });

  it("fatura vazia não fica atrasada nem paga", () => {
    expect(invoiceStatus({ ...invoice, totalCents: 0 }, "2027-01-01")).toBe("closed");
  });
});

describe("limite", () => {
  it("remainingCents nunca é negativo", () => {
    expect(remainingCents({ totalCents: 100, paidCents: 150 })).toBe(0);
  });

  it("limite usado soma só o que falta pagar", () => {
    expect(
      usedLimitCents([
        { totalCents: 1000, paidCents: 1000 },
        { totalCents: 1000, paidCents: 400 },
        { totalCents: 500, paidCents: 0 },
      ]),
    ).toBe(1100);
  });
});

describe("agrupamento", () => {
  const make = (month: string, closing: string, due: string, total = 100, paid = 0) => ({
    referenceMonth: month,
    closingDate: closing,
    dueDate: due,
    totalCents: total,
    paidCents: paid,
  });
  const list = [
    make("2026-12-01", "2026-12-10", "2026-12-20"),
    make("2026-10-01", "2026-10-10", "2026-10-20", 100, 100),
    make("2027-01-01", "2027-01-10", "2027-01-20"),
    make("2026-11-01", "2026-11-10", "2026-11-20"),
  ];

  it("separa atual, próximas e anteriores", () => {
    const { current, upcoming, previous } = groupInvoices(list, "2026-11-15");
    expect(current?.referenceMonth).toBe("2026-12-01");
    expect(upcoming.map((i) => i.referenceMonth)).toEqual(["2027-01-01"]);
    expect(previous.map((i) => i.referenceMonth)).toEqual(["2026-11-01", "2026-10-01"]);
  });

  it("a próxima a pagar ignora as quitadas", () => {
    expect(nextInvoiceToPay(list)?.referenceMonth).toBe("2026-11-01");
    expect(nextInvoiceToPay([list[1]])).toBeNull();
  });
});
