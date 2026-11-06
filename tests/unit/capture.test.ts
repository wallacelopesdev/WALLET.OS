import { describe, expect, it } from "vitest";
import { parseBankMessage } from "@/features/capture/parse-message";
import { mapPluggyTransaction, reaisToCents } from "@/features/capture/pluggy-map";
import { captureBodySchema, parseCaptureAmount } from "@/features/capture/schema";

describe("parseBankMessage: movimentações", () => {
  it.each([
    [
      "Compra de R$ 25,90 APROVADA em PADARIA CENTRAL no cartão final 1234",
      { amountCents: -2590, description: "PADARIA CENTRAL", last4: "1234" },
    ],
    [
      "Você recebeu um Pix de R$ 150,00 de João Silva",
      { amountCents: 15000, description: "João Silva", method: "pix" },
    ],
    [
      "Pix enviado: R$ 1.234,56 para Maria Souza",
      { amountCents: -123456, description: "Maria Souza", method: "pix" },
    ],
    [
      "Compra no débito de R$ 40,00 em MERCADO BOM às 10:32",
      { amountCents: -4000, description: "MERCADO BOM", method: "debit" },
    ],
    [
      "Compra no crédito aprovada: R$ 99,99 em Loja X, final 9876",
      { amountCents: -9999, description: "Loja X", method: "credit", last4: "9876" },
    ],
    ["Transferência recebida de R$ 10,00", { amountCents: 1000 }],
  ])("%s", (text, expected) => {
    expect(parseBankMessage(text)).toMatchObject({ reason: null, ...expected });
  });

  it("aceita espaço não separável no valor", () => {
    expect(parseBankMessage("Compra aprovada R$ 12,00 em Café")?.amountCents).toBe(-1200);
  });

  it("usa um nome padrão sem o estabelecimento", () => {
    expect(parseBankMessage("Pix recebido R$ 5,00")?.description).toBe("Pix recebido");
    expect(parseBankMessage("Compra aprovada R$ 5,00")?.description).toBe("Compra capturada");
  });

  it("valor sem sentido claro vai para revisão", () => {
    expect(parseBankMessage("Movimentação de R$ 50,00 na sua conta")?.reason).toBe(
      "Não entendi se foi entrada ou saída",
    );
  });
});

describe("parseBankMessage: o que é ignorado", () => {
  it.each([
    "Seu código de verificação é 123456. Compra de R$ 10,00",
    "Use o token 998877 para aprovar R$ 50,00",
    "Sua senha temporária: 1234",
    "Sua fatura fechou em R$ 1.200,00",
    "Fatura vence amanhã: R$ 300,00",
    "Seu limite disponível é R$ 5.000,00",
    "Você tem R$ 10.000,00 pré-aprovados em empréstimo",
    "Oferta: parcele em até 12x R$ 99,00",
    "Compra de R$ 25,00 recusada em LOJA",
    "Compra de R$ 25,00 não autorizada",
    "Pix de R$ 20,00 agendado",
    "Ganhe R$ 20,00 de cashback",
    "Seu saldo disponível é R$ 100,00",
    "Bom dia! Temos novidades para você",
    "",
  ])("%j", (text) => {
    expect(parseBankMessage(text)).toBeNull();
  });
});

describe("parseCaptureAmount", () => {
  it.each([
    ["R$ 12,34", 1234],
    ["R$ 12,34", 1234],
    ["12,34", 1234],
    ["12.34", 1234],
    ["1.234,56", 123456],
    [12.34, 1234],
    [19.99, 1999],
    [7, 700],
    ["BRL 12,34", 1234],
    ["12,34 BRL", 1234],
  ])("%j vira %i centavos", (input, cents) => {
    expect(parseCaptureAmount(input)).toBe(cents);
  });

  it.each(["", "abc", 0, -5, "-5,00", "US$ 12,00", "$12.00", Number.NaN, Number.POSITIVE_INFINITY])(
    "rejeita %j",
    (input) => {
      expect(parseCaptureAmount(input)).toBeNull();
    },
  );
});

describe("captureBodySchema", () => {
  it("aceita Apple Pay e texto", () => {
    expect(captureBodySchema.safeParse({ source: "apple_pay", merchant: "Café", amount: "R$ 5,00", card: "Nubank" }).success).toBe(true);
    expect(captureBodySchema.safeParse({ source: "notification", text: "Compra R$ 5,00", card: "Nubank" }).success).toBe(true);
  });

  it("recusa origem desconhecida, tipos errados e excessos", () => {
    expect(captureBodySchema.safeParse({ source: "pluggy", text: "x" }).success).toBe(false);
    expect(captureBodySchema.safeParse({ source: "sms", text: 1 }).success).toBe(false);
    expect(captureBodySchema.safeParse({ source: "sms", text: "x".repeat(2001) }).success).toBe(false);
  });

  it("exige texto ou valor", () => {
    expect(captureBodySchema.safeParse({ source: "apple_pay", merchant: "Café" }).success).toBe(false);
  });
});

describe("reaisToCents", () => {
  it.each([
    [19.99, 1999],
    [1.15, 115],
    [4.35, 435],
    [1001.1, 100110],
    [-75, 7500],
    [0.01, 1],
    [0, 0],
  ])("%d vira %i", (amount, cents) => {
    expect(reaisToCents(amount)).toBe(cents);
  });
});

describe("mapPluggyTransaction", () => {
  const TODAY = "2026-11-05";
  const base = { id: "t1", description: "Mercado", amount: 75, date: "2026-11-04T00:00:00.000Z" };

  describe("conta", () => {
    it("saída e entrada seguem `type`", () => {
      expect(mapPluggyTransaction({ ...base, type: "DEBIT", amount: 75 }, "BANK", TODAY)).toMatchObject({
        amountCents: -7500,
        externalRef: "pluggy:t1",
        date: "2026-11-04",
      });
      expect(mapPluggyTransaction({ ...base, type: "DEBIT", amount: -75 }, "BANK", TODAY)?.amountCents).toBe(-7500);
      expect(mapPluggyTransaction({ ...base, type: "CREDIT", amount: 75 }, "BANK", TODAY)?.amountCents).toBe(7500);
    });

    it("ignora o que ainda não foi efetivado ou está no futuro", () => {
      expect(mapPluggyTransaction({ ...base, type: "DEBIT", status: "PENDING" }, "BANK", TODAY)).toBeNull();
      expect(
        mapPluggyTransaction({ ...base, type: "DEBIT", date: "2026-11-10T00:00:00.000Z" }, "BANK", TODAY),
      ).toBeNull();
    });

    it("identifica o método", () => {
      const method = (description: string, operationType?: string) =>
        mapPluggyTransaction({ ...base, type: "DEBIT", description, operationType }, "BANK", TODAY)?.method;
      expect(method("PIX ENVIADO JOAO")).toBe("pix");
      expect(method("Pagamento", "PIX")).toBe("pix");
      expect(method("PAGTO BOLETO")).toBe("boleto");
      expect(method("COMPRA CARTAO DEBITO")).toBe("debit");
      expect(method("Qualquer")).toBeNull();
    });

    it("pagamento de fatura e transferência vão para revisão, nunca como despesa", () => {
      expect(
        mapPluggyTransaction({ ...base, type: "DEBIT", operationType: "PAGAMENTO_FATURA" }, "BANK", TODAY)?.reason,
      ).toMatch(/Pagamento de fatura/);
      expect(
        mapPluggyTransaction({ ...base, type: "DEBIT", operationType: "TRANSFERENCIA_MESMA_INSTITUICAO" }, "BANK", TODAY)?.reason,
      ).toMatch(/transferência/);
    });
  });

  describe("cartão", () => {
    it("positivo é compra e vira saída", () => {
      expect(mapPluggyTransaction(base, "CREDIT", TODAY)).toMatchObject({
        amountCents: -7500,
        method: "credit",
        reason: null,
      });
    });

    it("compra em aberto e parcela futura entram", () => {
      const future = mapPluggyTransaction(
        {
          ...base,
          status: "PENDING",
          date: "2027-01-04T00:00:00.000Z",
          creditCardMetadata: { installmentNumber: 3, totalInstallments: 10 },
        },
        "CREDIT",
        TODAY,
      );
      expect(future).toMatchObject({ description: "Mercado (3/10)", date: "2027-01-04", amountCents: -7500 });
    });

    it("pagamento recebido é ignorado", () => {
      expect(
        mapPluggyTransaction({ ...base, amount: -150, operationType: "PAGAMENTO_FATURA" }, "CREDIT", TODAY),
      ).toBeNull();
    });

    it("outro crédito vai para revisão", () => {
      expect(mapPluggyTransaction({ ...base, amount: -20 }, "CREDIT", TODAY)).toMatchObject({
        amountCents: 2000,
        reason: "Estorno ou crédito no cartão",
      });
    });

    it("usa o nome do estabelecimento quando existe", () => {
      expect(
        mapPluggyTransaction({ ...base, merchant: { name: "Padaria" } }, "CREDIT", TODAY)?.description,
      ).toBe("Padaria");
    });
  });

  it("valor zero é ignorado", () => {
    expect(mapPluggyTransaction({ ...base, amount: 0 }, "CREDIT", TODAY)).toBeNull();
  });
});
