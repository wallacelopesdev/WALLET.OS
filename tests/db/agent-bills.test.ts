import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  USER_A,
  USER_B,
  applyMigration,
  asAnon,
  asUser,
  createDatabase,
  createUser,
  insertAccount,
} from "./harness";

describe("boletos", () => {
  let db: PGlite;
  let account: string;
  let counter = 0;

  const addBill = async (beneficiary: string, amount: number, due: string, userId = USER_A) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.bills (user_id, beneficiary, amount_cents, due_date) values ($1, $2, $3, $4) returning id`,
      [userId, beneficiary, amount, due],
    );
    return rows[0].id;
  };

  const payment = async (description: string, amount: number, date: string, method: string | null = "boleto") => {
    counter += 1;
    const { rows } = await db.query<{ id: string }>(
      `insert into public.transactions (user_id, account_id, posted_at, description, amount_cents, kind, payment_method, dedupe_hash)
       values ($1, $2, $3, $4, $5, 'expense', $6::public.payment_method, $7) returning id`,
      [USER_A, account, date, description, -amount, method, `bill:${counter}`],
    );
    return rows[0].id;
  };

  const billOf = async (id: string) => {
    const { rows } = await db.query<{ paid_transaction_id: string | null; paid_amount_cents: number | null }>(
      "select paid_transaction_id, paid_amount_cents from public.bills where id = $1",
      [id],
    );
    return rows[0];
  };

  beforeAll(async () => {
    db = await createDatabase();
    for (const file of [
      "0002_accounts.sql",
      "0003_categories.sql",
      "0004_transaction_types.sql",
      "0005_transactions.sql",
      "0006_cards.sql",
      "0007_capture.sql",
      "0008_agent_core.sql",
      "0009_agent_bills.sql",
    ]) {
      await applyMigration(db, file);
    }
    await createUser(db, USER_A, "a@teste.dev");
    await createUser(db, USER_B, "b@teste.dev");
  });

  beforeEach(async () => {
    await db.exec(`
      delete from public.bills;
      delete from public.transactions;
      delete from public.bank_accounts;
    `);
    account = await insertAccount(db, USER_A, "Conta", 100000);
  });

  it("cadastrar não marca como pago", async () => {
    const id = await addBill("Enel", 15000, "2026-11-20");
    expect((await billOf(id)).paid_transaction_id).toBeNull();
  });

  it("o cliente não consegue marcar como pago à mão", async () => {
    const id = await addBill("Enel", 15000, "2026-11-20");
    const tx = await payment("Outra", 1, "2026-01-01", null);
    await asUser(db, USER_A, async () => {
      await expect(
        db.query("update public.bills set paid_transaction_id = $1 where id = $2", [tx, id]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("update public.bills set paid_at = '2026-01-01' where id = $1", [id]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("pagamento de boleto com valor igual confirma", async () => {
    const id = await addBill("Enel", 15000, "2026-11-20");
    const tx = await payment("PAG BOLETO 123", 15000, "2026-11-19");
    expect(await billOf(id)).toMatchObject({ paid_transaction_id: tx });
  });

  it("com multa e juros, exige beneficiário parecido e registra o valor pago", async () => {
    const id = await addBill("Enel Energia", 10000, "2026-11-20");
    const tx = await payment("BOLETO ENEL ENERGIA", 10500, "2026-11-25");
    const bill = await billOf(id);
    expect(bill.paid_transaction_id).toBe(tx);
    expect(Number(bill.paid_amount_cents)).toBe(10500);
  });

  it("valor acima, com outro beneficiário, não confirma", async () => {
    const id = await addBill("Enel", 10000, "2026-11-20");
    await payment("BOLETO SABESP", 10500, "2026-11-25");
    expect((await billOf(id)).paid_transaction_id).toBeNull();
  });

  it("valor acima de 20% não confirma", async () => {
    const id = await addBill("Enel", 10000, "2026-11-20");
    await payment("BOLETO ENEL", 12001, "2026-11-25");
    expect((await billOf(id)).paid_transaction_id).toBeNull();
  });

  it("despesa que não é boleto não confirma", async () => {
    const id = await addBill("Enel", 15000, "2026-11-20");
    await payment("Enel", 15000, "2026-11-19", "pix");
    expect((await billOf(id)).paid_transaction_id).toBeNull();
  });

  it("vencimento distante não confirma", async () => {
    const id = await addBill("Enel", 15000, "2026-11-20");
    await payment("BOLETO", 15000, "2026-07-01");
    expect((await billOf(id)).paid_transaction_id).toBeNull();
  });

  it("dois boletos iguais: não adivinha", async () => {
    const a = await addBill("Enel", 15000, "2026-11-20");
    const b = await addBill("Sabesp", 15000, "2026-11-21");
    await payment("PAG BOLETO", 15000, "2026-11-20");
    expect((await billOf(a)).paid_transaction_id).toBeNull();
    expect((await billOf(b)).paid_transaction_id).toBeNull();
  });

  it("boleto dispensado não é confirmado", async () => {
    const id = await addBill("Enel", 15000, "2026-11-20");
    await asUser(db, USER_A, () => db.query("update public.bills set dismissed = true where id = $1", [id]));
    await payment("BOLETO", 15000, "2026-11-20");
    expect((await billOf(id)).paid_transaction_id).toBeNull();
  });

  it("excluir a transação reabre o boleto", async () => {
    const id = await addBill("Enel", 15000, "2026-11-20");
    const tx = await payment("BOLETO", 15000, "2026-11-20");
    await db.query("delete from public.transactions where id = $1", [tx]);
    expect(await billOf(id)).toEqual({ paid_transaction_id: null, paid_amount_cents: null });
  });

  it("o pagamento de um usuário não confirma boleto de outro", async () => {
    const id = await addBill("Enel", 15000, "2026-11-20", USER_B);
    await payment("BOLETO", 15000, "2026-11-20");
    expect((await billOf(id)).paid_transaction_id).toBeNull();
  });

  it("B não lê nem altera boletos de A; anon não acessa", async () => {
    const id = await addBill("Enel", 15000, "2026-11-20");
    await asUser(db, USER_B, async () => {
      expect((await db.query("select 1 from public.bills")).rows).toHaveLength(0);
      const updated = await db.query("update public.bills set dismissed = true where id = $1", [id]);
      expect(updated.affectedRows).toBe(0);
      await expect(
        db.query("insert into public.bills (user_id, beneficiary, amount_cents, due_date) values ($1, 'X', 1, '2026-01-01')", [USER_A]),
      ).rejects.toThrow(/row-level security/);
    });
    await asAnon(db, async () => {
      await expect(db.query("select 1 from public.bills")).rejects.toThrow(/permission denied/);
    });
  });
});
