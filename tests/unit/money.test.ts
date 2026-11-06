import { describe, expect, it } from "vitest";
import { MAX_CENTS, centsToInput, parseBRLToCents } from "@/lib/money";

describe("parseBRLToCents", () => {
  it.each([
    ["1.234,56", 123456],
    ["1234,56", 123456],
    ["1234", 123400],
    ["1.234", 123400],
    ["1.234.567,89", 123456789],
    ["12.50", 1250],
    ["12.5", 1250],
    ["10,5", 1050],
    ["0,01", 1],
    ["0", 0],
    ["0,00", 0],
    ["R$ 10,00", 1000],
    ["R$ 1.000,00", 100000],
    ["  42  ", 4200],
    ["007,50", 750],
    ["-50", -5000],
    ["-1.234,56", -123456],
    ["-R$ 10,00", -1000],
    ["-0,00", 0],
  ])("converte %j em %i centavos", (input, cents) => {
    expect(parseBRLToCents(input)).toBe(cents);
  });

  it.each([
    "",
    "   ",
    "abc",
    "-",
    "R$",
    "12,345",
    "1,2,3",
    "12.345,6.7",
    "1.23,45",
    "12.3456",
    "1e5",
    "0x10",
    "NaN",
    "Infinity",
    "--5",
    "5-",
    "+5",
    ",50",
    "10,",
    "99999999999999",
  ])("rejeita %j", (input) => {
    expect(parseBRLToCents(input)).toBeNull();
  });

  it("nunca sofre erro de arredondamento de ponto flutuante", () => {
    // Em float: 19.99 * 100 = 1998.9999999999998 e 1.15 * 100 = 114.99999999999999
    expect(parseBRLToCents("19,99")).toBe(1999);
    expect(parseBRLToCents("1,15")).toBe(115);
    expect(parseBRLToCents("4,35")).toBe(435);
    expect(parseBRLToCents("1.001,10")).toBe(100110);
  });

  it("respeita o limite exato", () => {
    expect(parseBRLToCents("1.000.000.000.000,00")).toBe(MAX_CENTS);
    expect(parseBRLToCents("1.000.000.000.000,01")).toBeNull();
    expect(parseBRLToCents("-1.000.000.000.000,00")).toBe(-MAX_CENTS);
  });

  it("sempre devolve inteiro seguro", () => {
    for (let cents = 0; cents < 20000; cents += 7) {
      const parsed = parseBRLToCents(centsToInput(cents));
      expect(parsed).toBe(cents);
      expect(Number.isSafeInteger(parsed)).toBe(true);
    }
  });
});

describe("centsToInput", () => {
  it.each([
    [0, "0,00"],
    [5, "0,05"],
    [100, "1,00"],
    [123456, "1.234,56"],
    [123456789, "1.234.567,89"],
    [-5000, "-50,00"],
    [MAX_CENTS, "1.000.000.000.000,00"],
  ])("formata %i como %j", (cents, text) => {
    expect(centsToInput(cents)).toBe(text);
  });

  it("é o inverso de parseBRLToCents", () => {
    for (const cents of [0, 1, -1, 99, 100, 123456, -987654321, MAX_CENTS]) {
      expect(parseBRLToCents(centsToInput(cents))).toBe(cents);
    }
  });
});
