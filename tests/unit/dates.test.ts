import { describe, expect, it } from "vitest";
import {
  addMonths,
  formatMonth,
  isValidISODate,
  isValidISOMonth,
  monthRange,
  todayInSaoPaulo,
} from "@/lib/dates";

describe("todayInSaoPaulo", () => {
  it("ainda é o dia anterior às 22h em Brasília, quando já é outro dia em UTC", () => {
    expect(todayInSaoPaulo(new Date("2026-11-06T01:00:00Z"))).toBe("2026-11-05");
  });

  it("vira o dia à meia-noite de Brasília", () => {
    expect(todayInSaoPaulo(new Date("2026-11-06T03:00:00Z"))).toBe("2026-11-06");
  });

  it("vira o ano corretamente", () => {
    expect(todayInSaoPaulo(new Date("2027-01-01T02:59:59Z"))).toBe("2026-12-31");
  });
});

describe("isValidISODate", () => {
  it.each(["2026-11-05", "2024-02-29", "2026-12-31"])("aceita %s", (value) => {
    expect(isValidISODate(value)).toBe(true);
  });

  it.each(["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-1-1", "05/11/2026", "", "abc"])(
    "rejeita %j",
    (value) => {
      expect(isValidISODate(value)).toBe(false);
    },
  );
});

describe("isValidISOMonth", () => {
  it("aceita mês real e rejeita o resto", () => {
    expect(isValidISOMonth("2026-11")).toBe(true);
    expect(isValidISOMonth("2026-13")).toBe(false);
    expect(isValidISOMonth("2026-11-01")).toBe(false);
  });
});

describe("monthRange", () => {
  it.each([
    ["2026-01", "2026-01-31"],
    ["2026-02", "2026-02-28"],
    ["2024-02", "2024-02-29"],
    ["2026-04", "2026-04-30"],
    ["2026-12", "2026-12-31"],
  ])("%s termina em %s", (month, to) => {
    expect(monthRange(month)).toEqual({ from: `${month}-01`, to });
  });
});

describe("addMonths", () => {
  it("atravessa anos nos dois sentidos", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-11", 14)).toBe("2028-01");
  });
});

describe("formatMonth", () => {
  it("usa o mês por extenso com inicial maiúscula", () => {
    expect(formatMonth("2026-11")).toBe("Novembro de 2026");
  });
});
