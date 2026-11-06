import { describe, expect, it } from "vitest";
import {
  escapeLike,
  filtersToQuery,
  hasActiveFilters,
  parseTransactionFilters,
  toTransactionRow,
  transactionFormSchema,
  transferFormSchema,
} from "@/features/transactions/schema";
import { addMonths, todayInSaoPaulo } from "@/lib/dates";

const ACCOUNT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CATEGORY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQUEST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const validTx = {
  requestId: REQUEST,
  kind: "expense",
  description: "Mercado",
  amount: "123,45",
  accountId: ACCOUNT_1,
  categoryId: CATEGORY,
  postedAt: "2026-01-15",
  competenceDate: "",
  paymentMethod: "pix",
  notes: "",
};

const validTransfer = {
  requestId: REQUEST,
  fromAccountId: ACCOUNT_1,
  toAccountId: ACCOUNT_2,
  amount: "100,00",
  postedAt: "2026-01-15",
  description: "",
  notes: "",
};

const issuesOf = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((i) => i.path[0]) ?? [];

describe("transactionFormSchema", () => {
  it("converte o valor em centavos e normaliza vazios", () => {
    const parsed = transactionFormSchema.parse({ ...validTx, categoryId: "", notes: "  " });
    expect(parsed.amount).toBe(12345);
    expect(parsed.notes).toBeNull();
  });

  it.each(["0", "0,00", "-10,00", "abc", "", "1,234", "99999999999999"])(
    "rejeita o valor %j",
    (amount) => {
      const result = transactionFormSchema.safeParse({ ...validTx, amount });
      expect(result.success).toBe(false);
      expect(issuesOf(result)).toEqual(["amount"]);
    },
  );

  it.each(["transfer", "invoice_payment", "refund", ""])("rejeita o tipo %j", (kind) => {
    expect(transactionFormSchema.safeParse({ ...validTx, kind }).success).toBe(false);
  });

  it("exige descrição e limita o tamanho", () => {
    expect(transactionFormSchema.safeParse({ ...validTx, description: "  " }).success).toBe(false);
    expect(transactionFormSchema.safeParse({ ...validTx, description: "x".repeat(200) }).success).toBe(true);
    expect(transactionFormSchema.safeParse({ ...validTx, description: "x".repeat(201) }).success).toBe(false);
  });

  it("exige conta e requisição válidas", () => {
    expect(transactionFormSchema.safeParse({ ...validTx, accountId: "" }).success).toBe(false);
    expect(transactionFormSchema.safeParse({ ...validTx, requestId: "x" }).success).toBe(false);
  });

  it("aceita hoje e rejeita amanhã na data da movimentação", () => {
    const today = todayInSaoPaulo();
    const tomorrow = todayInSaoPaulo(new Date(Date.now() + 86_400_000));
    expect(transactionFormSchema.safeParse({ ...validTx, postedAt: today }).success).toBe(true);
    const result = transactionFormSchema.safeParse({ ...validTx, postedAt: tomorrow });
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual(["postedAt"]);
  });

  it.each(["2026-02-30", "15/01/2026", "", "1999-12-31"])(
    "rejeita a data de movimentação %j",
    (postedAt) => {
      expect(transactionFormSchema.safeParse({ ...validTx, postedAt }).success).toBe(false);
    },
  );

  it("permite competência futura, mas não data inexistente", () => {
    const future = `${addMonths(todayInSaoPaulo().slice(0, 7), 3)}-01`;
    expect(transactionFormSchema.safeParse({ ...validTx, competenceDate: future }).success).toBe(true);
    expect(transactionFormSchema.safeParse({ ...validTx, competenceDate: "2026-02-30" }).success).toBe(false);
  });

  it("rejeita método desconhecido e aceita vazio", () => {
    expect(transactionFormSchema.safeParse({ ...validTx, paymentMethod: "cheque" }).success).toBe(false);
    expect(transactionFormSchema.safeParse({ ...validTx, paymentMethod: "" }).success).toBe(true);
  });

  it("ignora campos forjados", () => {
    const parsed = transactionFormSchema.parse({ ...validTx, user_id: "x", amount_cents: 1 });
    expect(parsed).not.toHaveProperty("user_id");
    expect(parsed).not.toHaveProperty("amount_cents");
  });
});

describe("toTransactionRow", () => {
  it("despesa fica negativa", () => {
    const row = toTransactionRow(transactionFormSchema.parse(validTx));
    expect(row.amount_cents).toBe(-12345);
    expect(row.category_source).toBe("manual");
  });

  it("receita fica positiva", () => {
    const row = toTransactionRow(transactionFormSchema.parse({ ...validTx, kind: "income" }));
    expect(row.amount_cents).toBe(12345);
  });

  it("campos opcionais vazios viram nulos", () => {
    const row = toTransactionRow(
      transactionFormSchema.parse({ ...validTx, categoryId: "", paymentMethod: "" }),
    );
    expect(row.category_id).toBeNull();
    expect(row.category_source).toBeNull();
    expect(row.payment_method).toBeNull();
    expect(row.competence_date).toBeNull();
  });
});

describe("transferFormSchema", () => {
  it("usa a descrição padrão", () => {
    expect(transferFormSchema.parse(validTransfer).description).toBe("Transferência");
  });

  it("rejeita a mesma conta nos dois lados", () => {
    const result = transferFormSchema.safeParse({ ...validTransfer, toAccountId: ACCOUNT_1 });
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual(["toAccountId"]);
  });

  it.each(["0,00", "-5", "abc"])("rejeita o valor %j", (amount) => {
    expect(transferFormSchema.safeParse({ ...validTransfer, amount }).success).toBe(false);
  });
});

describe("parseTransactionFilters", () => {
  it("usa os padrões sem parâmetros", () => {
    const filters = parseTransactionFilters({});
    expect(filters).toEqual({
      q: "",
      kind: null,
      categoryId: null,
      accountId: null,
      from: null,
      to: null,
      sort: "data_desc",
      page: 1,
    });
    expect(hasActiveFilters(filters)).toBe(false);
  });

  it("lê os filtros válidos", () => {
    const filters = parseTransactionFilters({
      q: " mercado ",
      tipo: "expense",
      categoria: CATEGORY,
      conta: ACCOUNT_1,
      de: "2026-01-01",
      ate: "2026-01-31",
      ordem: "valor_desc",
      pagina: "3",
    });
    expect(filters).toMatchObject({
      q: "mercado",
      kind: "expense",
      categoryId: CATEGORY,
      accountId: ACCOUNT_1,
      from: "2026-01-01",
      to: "2026-01-31",
      sort: "valor_desc",
      page: 3,
    });
    expect(hasActiveFilters(filters)).toBe(true);
  });

  it("ignora valores inválidos da URL", () => {
    const filters = parseTransactionFilters({
      tipo: "drop table",
      categoria: "1 or 1=1",
      conta: "x",
      de: "2026-02-30",
      ate: "ontem",
      ordem: "id;--",
      pagina: "-1",
    });
    expect(hasActiveFilters(filters)).toBe(false);
    expect(filters.sort).toBe("data_desc");
    expect(filters.page).toBe(1);
  });

  it("aceita período invertido", () => {
    const filters = parseTransactionFilters({ de: "2026-02-01", ate: "2026-01-01" });
    expect(filters.from).toBe("2026-01-01");
    expect(filters.to).toBe("2026-02-01");
  });

  it("ignora parâmetros repetidos", () => {
    expect(parseTransactionFilters({ q: ["a", "b"] }).q).toBe("");
  });

  it("limita o tamanho da busca", () => {
    expect(parseTransactionFilters({ q: "x".repeat(500) }).q).toHaveLength(100);
  });
});

describe("filtersToQuery", () => {
  it("mantém os filtros e troca a página", () => {
    const filters = parseTransactionFilters({ q: "a b", tipo: "income", ordem: "valor_asc" });
    expect(filtersToQuery(filters, 2)).toBe("?q=a+b&tipo=income&ordem=valor_asc&pagina=2");
  });

  it("omite os valores padrão", () => {
    expect(filtersToQuery(parseTransactionFilters({}), 1)).toBe("");
  });
});

describe("escapeLike", () => {
  it("neutraliza os curingas", () => {
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
  });
});
