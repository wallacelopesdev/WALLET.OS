import { describe, expect, it } from "vitest";
import { ACCOUNT_KINDS } from "@/features/accounts/constants";
import {
  accountFormSchema,
  accountIdSchema,
  findDuplicateAccount,
} from "@/features/accounts/schema";

const valid = {
  name: "Conta principal",
  institution: "Nubank",
  kind: "checking",
  openingBalance: "1.234,56",
};

describe("accountFormSchema", () => {
  it("converte o formulário em dados do banco, com saldo em centavos", () => {
    expect(accountFormSchema.parse(valid)).toEqual({
      name: "Conta principal",
      institution: "Nubank",
      kind: "checking",
      opening_balance_cents: 123456,
    });
  });

  it("remove espaços das pontas", () => {
    const parsed = accountFormSchema.parse({
      ...valid,
      name: "  Conta  ",
      institution: "  Itaú ",
    });
    expect(parsed.name).toBe("Conta");
    expect(parsed.institution).toBe("Itaú");
  });

  it.each(ACCOUNT_KINDS)("aceita o tipo %s", (kind) => {
    expect(accountFormSchema.safeParse({ ...valid, kind }).success).toBe(true);
  });

  it("rejeita tipo desconhecido", () => {
    const result = accountFormSchema.safeParse({ ...valid, kind: "crypto" });
    expect(result.success).toBe(false);
  });

  it("exige nome e limita o tamanho", () => {
    expect(accountFormSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
    expect(accountFormSchema.safeParse({ ...valid, name: "x".repeat(80) }).success).toBe(true);
    expect(accountFormSchema.safeParse({ ...valid, name: "x".repeat(81) }).success).toBe(false);
  });

  it.each(["checking", "savings", "digital", "investment", "other"])(
    "exige instituição para %s",
    (kind) => {
      const result = accountFormSchema.safeParse({ ...valid, kind, institution: " " });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(["institution"]);
      }
    },
  );

  it.each(["wallet", "cash"])("guarda instituição nula para %s", (kind) => {
    const parsed = accountFormSchema.parse({ ...valid, kind, institution: "" });
    expect(parsed.institution).toBeNull();
  });

  it("aceita saldo inicial zero e negativo", () => {
    expect(
      accountFormSchema.parse({ ...valid, openingBalance: "0,00" }).opening_balance_cents,
    ).toBe(0);
    expect(
      accountFormSchema.parse({ ...valid, openingBalance: "-50,10" }).opening_balance_cents,
    ).toBe(-5010);
  });

  it.each(["", "abc", "1,234", "1e9", "99999999999999"])(
    "rejeita saldo inicial %j",
    (openingBalance) => {
      expect(accountFormSchema.safeParse({ ...valid, openingBalance }).success).toBe(false);
    },
  );

  it("não aceita campos ausentes nem saldo forjado", () => {
    expect(accountFormSchema.safeParse({}).success).toBe(false);
    const parsed = accountFormSchema.parse({
      ...valid,
      balance_cents: 999999,
      user_id: "outro",
    });
    expect(parsed).not.toHaveProperty("balance_cents");
    expect(parsed).not.toHaveProperty("user_id");
  });
});

describe("accountIdSchema", () => {
  it("só aceita UUID", () => {
    expect(accountIdSchema.safeParse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").success).toBe(true);
    expect(accountIdSchema.safeParse("1 or 1=1").success).toBe(false);
  });
});

describe("findDuplicateAccount", () => {
  const existing = [
    { id: "1", name: "Principal", institution: "Nubank" },
    { id: "2", name: "Carteira", institution: null },
  ];

  it("ignora maiúsculas e espaços", () => {
    const found = findDuplicateAccount(
      { name: " principal ", institution: "NUBANK" },
      existing,
    );
    expect(found?.id).toBe("1");
  });

  it("trata instituições nulas como iguais", () => {
    expect(findDuplicateAccount({ name: "carteira", institution: null }, existing)?.id).toBe("2");
  });

  it("permite o mesmo nome em outra instituição", () => {
    expect(
      findDuplicateAccount({ name: "Principal", institution: "Itaú" }, existing),
    ).toBeUndefined();
  });

  it("não acusa a própria conta ao editar", () => {
    expect(
      findDuplicateAccount({ name: "Principal", institution: "Nubank" }, existing, "1"),
    ).toBeUndefined();
  });
});
