import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  USER_A,
  USER_B,
  applyMigration,
  asAnon,
  asUser,
  balanceOf,
  createDatabase,
  createUser,
  insertAccount,
} from "./harness";

const MIGRATIONS = [
  "0002_accounts.sql",
  "0003_categories.sql",
  "0004_transaction_types.sql",
  "0005_transactions.sql",
  "0006_cards.sql",
];

let counter = 0;
const uuid = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

async function insertCard(
  db: PGlite,
  userId: string,
  name: string,
  closing: number,
  due: number,
  limit = 500000,
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.credit_cards (user_id, institution, name, limit_cents, closing_day, due_day)
     values ($1, 'Banco', $2, $3, $4, $5) returning id`,
    [userId, name, limit, closing, due],
  );
  return rows[0].id;
}

const purchase = (
  db: PGlite,
  card: string,
  amount: number,
  installments: number,
  date: string,
  options: { category?: string | null; request?: string } = {},
) =>
  db.query<{ id: string }>(
    `select public.create_card_purchase($1, 'Compra', $2, $3, $4, $5, null, $6) as id`,
    [card, amount, installments, date, options.category ?? null, options.request ?? uuid()],
  );

const pay = (db: PGlite, invoice: string, account: string, amount: number, request = uuid()) =>
  db.query<{ id: string }>(
    `select public.pay_invoice($1, $2, $3, '2026-11-05', $4) as id`,
    [invoice, account, amount, request],
  );

type InvoiceRow = {
  id: string;
  reference_month: string;
  closing_date: string;
  due_date: string;
  total_cents: number;
  paid_cents: number;
  status: string;
};

async function invoices(db: PGlite, card: string): Promise<InvoiceRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select id, reference_month::text as reference_month, closing_date::text as closing_date,
            due_date::text as due_date, total_cents, paid_cents, status
       from public.card_invoices where card_id = $1 order by reference_month`,
    [card],
  );
  return rows.map((r) => ({
    ...(r as InvoiceRow),
    total_cents: Number(r.total_cents),
    paid_cents: Number(r.paid_cents),
  }));
}

describe("migration 0006 sobre dados existentes", () => {
  it("preserva faturas digitadas à mão e marca as pagas", async () => {
    const db = await createDatabase();
    for (const file of MIGRATIONS.slice(0, 4)) await applyMigration(db, file);
    await createUser(db, USER_A, "a@teste.dev");
    const card = await insertCard(db, USER_A, "Antigo", 10, 20);
    await db.query(
      `insert into public.card_invoices (user_id, card_id, reference_month, closing_date, due_date, total_cents, status)
       values ($1, $2, '2026-09-01', '2026-09-10', '2026-09-20', 15000, 'paid'),
              ($1, $2, '2026-10-01', '2026-10-10', '2026-10-20', 9000, 'open')`,
      [USER_A, card],
    );

    await applyMigration(db, "0006_cards.sql");

    const rows = await invoices(db, card);
    expect(rows.map((r) => [r.total_cents, r.paid_cents])).toEqual([
      [15000, 15000],
      [9000, 0],
    ]);

    await purchase(db, card, 1000, 1, "2026-10-05").catch(() => undefined);
  });
});

describe("cartões e faturas", () => {
  let db: PGlite;
  let accountA: string;

  beforeAll(async () => {
    db = await createDatabase();
    for (const file of MIGRATIONS) await applyMigration(db, file);
    await createUser(db, USER_A, "a@teste.dev");
    await createUser(db, USER_B, "b@teste.dev");
  });

  beforeEach(async () => {
    await db.exec(`
      delete from public.transactions;
      delete from public.card_installments;
      delete from public.card_invoices;
      delete from public.credit_cards;
      delete from public.bank_accounts;
    `);
    accountA = await insertAccount(db, USER_A, "Principal", 1000000);
  });

  const asA = <T>(fn: () => Promise<T>) => asUser(db, USER_A, fn);

  describe("competência", () => {
    it.each([
      ["antes do fechamento fica no mês", "2026-03-09", 10, "2026-03-01"],
      ["no dia do fechamento vai para o seguinte", "2026-03-10", 10, "2026-04-01"],
      ["depois do fechamento vai para o seguinte", "2026-03-11", 10, "2026-04-01"],
      ["dezembro vira janeiro do ano seguinte", "2026-12-20", 10, "2027-01-01"],
      ["fechamento 31 em fevereiro usa o último dia", "2026-02-27", 31, "2026-02-01"],
      ["no último dia de fevereiro já é a seguinte", "2026-02-28", 31, "2026-03-01"],
      ["ano bissexto tem 29 de fevereiro", "2028-02-28", 31, "2028-02-01"],
      ["em 29/02 bissexto já é a seguinte", "2028-02-29", 31, "2028-03-01"],
    ])("%s", async (_label, date, closing, expected) => {
      const { rows } = await db.query<{ month: string }>(
        "select public.card_invoice_month($1, $2)::text as month",
        [date, closing],
      );
      expect(rows[0].month).toBe(expected);
    });
  });

  describe("datas da fatura", () => {
    it("vencimento depois do fechamento fica no mesmo mês", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, 1000, 1, "2026-03-05"));
      const [invoice] = await invoices(db, card);
      expect(invoice).toMatchObject({
        reference_month: "2026-03-01",
        closing_date: "2026-03-10",
        due_date: "2026-03-20",
      });
    });

    it("vencimento antes do fechamento vai para o mês seguinte", async () => {
      const card = await insertCard(db, USER_A, "C", 28, 5);
      await asA(() => purchase(db, card, 1000, 1, "2026-12-05"));
      const [invoice] = await invoices(db, card);
      expect(invoice).toMatchObject({
        reference_month: "2026-12-01",
        closing_date: "2026-12-28",
        due_date: "2027-01-05",
      });
    });

    it("dias inexistentes viram o último dia do mês", async () => {
      const card = await insertCard(db, USER_A, "C", 31, 30);
      await asA(() => purchase(db, card, 1000, 1, "2026-02-10"));
      const [invoice] = await invoices(db, card);
      expect(invoice).toMatchObject({ closing_date: "2026-02-28", due_date: "2026-03-30" });
    });
  });

  describe("compras", () => {
    it("não mexem no saldo de nenhuma conta", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, 25000, 1, "2026-03-05"));
      expect(await balanceOf(db, accountA)).toBe(1000000);
      expect((await invoices(db, card))[0].total_cents).toBe(25000);
    });

    it("gravam despesa no cartão, sem conta, com o método crédito", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, 2500, 1, "2026-03-05"));
      const { rows } = await db.query<Record<string, unknown>>(
        "select account_id, card_id, kind, payment_method, amount_cents from public.transactions",
      );
      expect(rows[0]).toMatchObject({
        account_id: null,
        card_id: card,
        kind: "expense",
        payment_method: "credit",
      });
      expect(Number(rows[0].amount_cents)).toBe(-2500);
    });

    it("são idempotentes pelo identificador da requisição", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      const request = uuid();
      const first = await asA(() => purchase(db, card, 1000, 3, "2026-03-05", { request }));
      const second = await asA(() => purchase(db, card, 1000, 3, "2026-03-05", { request }));
      expect(second.rows[0].id).toBe(first.rows[0].id);
      const { rows } = await db.query<{ n: number }>(
        "select count(*)::int as n from public.transactions",
      );
      expect(rows[0].n).toBe(3);
    });

    it.each([
      ["valor zero", 0, 1],
      ["valor negativo", -100, 1],
    ])("rejeitam %s", async (_label, amount, installments) => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await expect(
        asA(() => purchase(db, card, amount, installments, "2026-03-05")),
      ).rejects.toMatchObject({ code: "WL004" });
    });

    it("não são aceitas em cartão arquivado", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await db.query("update public.credit_cards set archived = true where id = $1", [card]);
      await expect(
        asA(() => purchase(db, card, 100, 1, "2026-03-05")),
      ).rejects.toMatchObject({ code: "WL009" });
    });

    it("respeitam o tipo da categoria", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      const { rows } = await db.query<{ id: string }>(
        "select id from public.transaction_categories where user_id = $1 and slug = 'salario'",
        [USER_A],
      );
      await expect(
        asA(() => purchase(db, card, 100, 1, "2026-03-05", { category: rows[0].id })),
      ).rejects.toMatchObject({ code: "WL001" });
    });

    it("não entram sem fatura por escrita direta", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(async () => {
        await expect(
          db.query(
            `insert into public.transactions (user_id, card_id, posted_at, description, amount_cents, kind, dedupe_hash)
             values ($1, $2, '2026-03-05', 'X', -100, 'expense', 'x')`,
            [USER_A, card],
          ),
        ).rejects.toMatchObject({ code: "WL010" });
      });
    });

    it("não trocam de cartão nem de fatura", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      const other = await insertCard(db, USER_A, "D", 10, 20);
      const { rows } = await asA(() => purchase(db, card, 100, 1, "2026-03-05"));
      await expect(
        db.query("update public.transactions set card_id = $1 where id = $2", [other, rows[0].id]),
      ).rejects.toMatchObject({ code: "WL010" });
    });
  });

  describe("parcelamentos", () => {
    it("distribuem os centavos e a soma é exatamente o total", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, 10000, 3, "2026-03-05"));
      const { rows } = await db.query<{ amount_cents: number; installment_number: number; installment_total: number }>(
        `select amount_cents, installment_number, installment_total
           from public.transactions order by installment_number`,
      );
      expect(rows.map((r) => Number(r.amount_cents))).toEqual([-3334, -3333, -3333]);
      expect(rows.map((r) => r.installment_number)).toEqual([1, 2, 3]);
      expect(rows.every((r) => r.installment_total === 3)).toBe(true);
      expect(rows.reduce((sum, r) => sum + Number(r.amount_cents), 0)).toBe(-10000);
    });

    it.each([
      [100, 7],
      [1, 1],
      [99999, 48],
      [1000000, 12],
      [7, 7],
    ])("%i centavos em %ix sempre somam o total", async (total, n) => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, total, n, "2026-03-05"));
      const rows = await invoices(db, card);
      expect(rows).toHaveLength(n);
      expect(rows.reduce((sum, r) => sum + r.total_cents, 0)).toBe(total);
    });

    it("criam uma fatura por mês, atravessando o ano", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, 30000, 3, "2026-11-20"));
      const rows = await invoices(db, card);
      expect(rows.map((r) => r.reference_month)).toEqual([
        "2026-12-01",
        "2027-01-01",
        "2027-02-01",
      ]);
      expect(rows.map((r) => r.total_cents)).toEqual([10000, 10000, 10000]);
    });

    it("datam cada parcela no mês certo, inclusive a partir do dia 31", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, 3000, 3, "2026-12-31"));
      const { rows } = await db.query<{ d: string }>(
        "select posted_at::text as d from public.transactions order by installment_number",
      );
      expect(rows.map((r) => r.d)).toEqual(["2026-12-31", "2027-01-31", "2027-02-28"]);
    });

    it("somam na fatura já existente do mês", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, 1000, 1, "2026-03-05"));
      await asA(() => purchase(db, card, 2000, 2, "2026-03-06"));
      const rows = await invoices(db, card);
      expect(rows.map((r) => r.total_cents)).toEqual([2000, 1000]);
    });

    it("registram o plano com o valor original", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, 10000, 3, "2026-03-05"));
      const { rows } = await db.query<Record<string, unknown>>(
        "select total_cents, installment_cents, installments_total, first_invoice_month::text as m from public.card_installments",
      );
      expect(Number(rows[0].total_cents)).toBe(10000);
      expect(Number(rows[0].installment_cents)).toBe(3333);
      expect(rows[0].installments_total).toBe(3);
      expect(rows[0].m).toBe("2026-03-01");
    });

    it.each([
      ["zero parcelas", 1000, 0],
      ["mais de 48 parcelas", 100000, 49],
      ["parcela abaixo de um centavo", 3, 5],
    ])("rejeitam %s", async (_label, amount, n) => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await expect(
        asA(() => purchase(db, card, amount, n, "2026-03-05")),
      ).rejects.toMatchObject({ code: "WL012" });
    });

    it("não aceitam excluir ou alterar só uma parcela", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, 3000, 3, "2026-03-05"));

      await db.exec("begin");
      await db.query("delete from public.transactions where installment_number = 2");
      await expect(db.exec("commit")).rejects.toMatchObject({ code: "WL011" });

      await db.exec("begin");
      await db.query("update public.transactions set amount_cents = -1 where installment_number = 2");
      await expect(db.exec("commit")).rejects.toMatchObject({ code: "WL011" });

      const rows = await invoices(db, card);
      expect(rows.map((r) => r.total_cents)).toEqual([1000, 1000, 1000]);
    });
  });

  describe("excluir compra", () => {
    it("remove todas as parcelas, o plano e as faturas que ficaram vazias", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      const { rows } = await asA(() => purchase(db, card, 3000, 3, "2026-03-05"));
      await asA(() => db.query("select public.delete_card_purchase($1)", [rows[0].id]));

      const txs = await db.query("select 1 from public.transactions");
      const plans = await db.query("select 1 from public.card_installments");
      expect(txs.rows).toHaveLength(0);
      expect(plans.rows).toHaveLength(0);
      expect(await invoices(db, card)).toHaveLength(0);
    });

    it("mantém a fatura que tem outras compras", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, 500, 1, "2026-03-05"));
      const { rows } = await asA(() => purchase(db, card, 300, 1, "2026-03-05"));
      await asA(() => db.query("select public.delete_card_purchase($1)", [rows[0].id]));
      expect((await invoices(db, card))[0].total_cents).toBe(500);
    });

    it("é recusada se a fatura já recebeu pagamento", async () => {
      const card = await insertCard(db, USER_A, "C", 10, 20);
      const { rows } = await asA(() => purchase(db, card, 1000, 1, "2026-03-05"));
      const [invoice] = await invoices(db, card);
      await asA(() => pay(db, invoice.id, accountA, 100));
      await expect(
        asA(() => db.query("select public.delete_card_purchase($1)", [rows[0].id])),
      ).rejects.toMatchObject({ code: "WL008" });
    });
  });

  describe("pagamentos", () => {
    let card: string;
    let invoice: InvoiceRow;

    beforeEach(async () => {
      card = await insertCard(db, USER_A, "C", 10, 20);
      await asA(() => purchase(db, card, 100000, 1, "2026-03-05"));
      [invoice] = await invoices(db, card);
    });

    it("debitam a conta, quitam a fatura e não geram despesa", async () => {
      await asA(() => pay(db, invoice.id, accountA, 100000));

      expect(await balanceOf(db, accountA)).toBe(900000);
      const [updated] = await invoices(db, card);
      expect(updated).toMatchObject({ paid_cents: 100000, status: "paid" });

      const { rows } = await db.query<{ kind: string; total: string }>(
        `select kind, sum(amount_cents)::text as total from public.transactions group by kind order by kind`,
      );
      // A despesa é só a compra; o pagamento fica em tipo próprio, fora de receitas e despesas.
      expect(rows).toEqual(
        expect.arrayContaining([
          { kind: "expense", total: "-100000" },
          { kind: "invoice_payment", total: "-100000" },
        ]),
      );
    });

    it("parcial mantém a fatura em aberto e soma até quitar", async () => {
      await asA(() => pay(db, invoice.id, accountA, 40000));
      expect((await invoices(db, card))[0]).toMatchObject({ paid_cents: 40000, status: "open" });
      await asA(() => pay(db, invoice.id, accountA, 60000));
      expect((await invoices(db, card))[0]).toMatchObject({ paid_cents: 100000, status: "paid" });
    });

    it("não duplicam com o mesmo identificador", async () => {
      const request = uuid();
      await asA(() => pay(db, invoice.id, accountA, 40000, request));
      await asA(() => pay(db, invoice.id, accountA, 40000, request));
      expect(await balanceOf(db, accountA)).toBe(960000);
      expect((await invoices(db, card))[0].paid_cents).toBe(40000);
    });

    it.each([
      ["acima do saldo da fatura", 100001, "WL007"],
      ["de valor zero", 0, "WL004"],
      ["negativo", -5, "WL004"],
    ])("rejeitam pagamento %s", async (_label, amount, code) => {
      await expect(asA(() => pay(db, invoice.id, accountA, amount))).rejects.toMatchObject({ code });
      expect(await balanceOf(db, accountA)).toBe(1000000);
    });

    it("rejeitam o segundo pagamento que passaria do total", async () => {
      await asA(() => pay(db, invoice.id, accountA, 100000));
      await expect(asA(() => pay(db, invoice.id, accountA, 1))).rejects.toMatchObject({ code: "WL007" });
    });

    it("não saem de conta arquivada", async () => {
      await db.query("update public.bank_accounts set archived = true where id = $1", [accountA]);
      await expect(asA(() => pay(db, invoice.id, accountA, 100))).rejects.toMatchObject({ code: "WL003" });
    });

    it("excluir o pagamento reabre a fatura e devolve o saldo", async () => {
      const { rows } = await asA(() => pay(db, invoice.id, accountA, 100000));
      await asA(() => db.query("delete from public.transactions where id = $1", [rows[0].id]));
      expect(await balanceOf(db, accountA)).toBe(1000000);
      expect((await invoices(db, card))[0]).toMatchObject({ paid_cents: 0, status: "open" });
    });
  });

  describe("isolamento entre usuários", () => {
    let card: string;
    let invoice: InvoiceRow;
    let accountB: string;

    beforeEach(async () => {
      card = await insertCard(db, USER_A, "Cartão de A", 10, 20);
      await asA(() => purchase(db, card, 100000, 1, "2026-03-05"));
      [invoice] = await invoices(db, card);
      accountB = await insertAccount(db, USER_B, "De B", 50000);
    });

    const asB = <T>(fn: () => Promise<T>) => asUser(db, USER_B, fn);

    it("B não lê cartões nem faturas de A", async () => {
      await asB(async () => {
        expect((await db.query("select 1 from public.credit_cards")).rows).toHaveLength(0);
        expect((await db.query("select 1 from public.card_invoices")).rows).toHaveLength(0);
      });
    });

    it("B não compra no cartão de A", async () => {
      await expect(asB(() => purchase(db, card, 100, 1, "2026-03-05"))).rejects.toMatchObject({
        code: "P0002",
      });
    });

    it("B não paga fatura de A nem exclui compra de A", async () => {
      await expect(asB(() => pay(db, invoice.id, accountB, 100))).rejects.toMatchObject({
        code: "P0002",
      });
      const { rows } = await db.query<{ id: string }>("select id from public.transactions limit 1");
      await expect(
        asB(() => db.query("select public.delete_card_purchase($1)", [rows[0].id])),
      ).rejects.toMatchObject({ code: "P0002" });
      expect(await balanceOf(db, accountB)).toBe(50000);
    });

    it("A não paga com a conta de B", async () => {
      await expect(asA(() => pay(db, invoice.id, accountB, 100))).rejects.toMatchObject({
        code: "23503",
      });
      expect(await balanceOf(db, accountB)).toBe(50000);
    });

    it("o cliente não altera total, status nem cria fatura", async () => {
      await asA(async () => {
        await expect(
          db.query("update public.card_invoices set total_cents = 0 where id = $1", [invoice.id]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.query("delete from public.card_invoices where id = $1", [invoice.id]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.query(
            `insert into public.card_invoices (user_id, card_id, reference_month, closing_date, due_date)
             values ($1, $2, '2030-01-01', '2030-01-10', '2030-01-20')`,
            [USER_A, card],
          ),
        ).rejects.toThrow(/permission denied/);
      });
    });

    it("o cliente não chama funções internas; anon não chama nenhuma", async () => {
      await asA(async () => {
        await expect(
          db.query("select public._ensure_card_invoice($1, $2, '2030-01-01')", [USER_A, card]),
        ).rejects.toThrow(/permission denied/);
      });
      await asAnon(db, async () => {
        await expect(purchase(db, card, 100, 1, "2026-03-05")).rejects.toThrow(/permission denied/);
      });
    });

    it("last4 só aceita quatro dígitos", async () => {
      await expect(
        db.query("update public.credit_cards set last4 = '12345678' where id = $1", [card]),
      ).rejects.toThrow();
      await expect(
        db.query("update public.credit_cards set last4 = 'abcd' where id = $1", [card]),
      ).rejects.toThrow();
    });
  });

  it("não impede excluir um usuário com cartões, parcelas e pagamentos", async () => {
    const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await createUser(db, userId, "c@teste.dev");
    const account = await insertAccount(db, userId, "Conta", 100000);
    const card = await insertCard(db, userId, "C", 10, 20);
    await asUser(db, userId, async () => {
      await purchase(db, card, 3000, 3, "2026-03-05");
      const [invoice] = await invoices(db, card);
      await pay(db, invoice.id, account, 1000);
    });

    await db.query("delete from auth.users where id = $1", [userId]);

    const { rows } = await db.query("select 1 from public.transactions where user_id = $1", [userId]);
    expect(rows).toHaveLength(0);
  });
});
