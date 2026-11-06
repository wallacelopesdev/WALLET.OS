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

const REQUEST_1 = "11111111-1111-4111-8111-111111111111";
const REQUEST_2 = "22222222-2222-4222-8222-222222222222";

async function migrateAll(db: PGlite) {
  for (const file of [
    "0002_accounts.sql",
    "0003_categories.sql",
    "0004_transaction_types.sql",
    "0005_transactions.sql",
  ]) {
    await applyMigration(db, file);
  }
}

async function categoryId(db: PGlite, userId: string, slug: string) {
  const { rows } = await db.query<{ id: string }>(
    "select id from public.transaction_categories where user_id = $1 and slug = $2",
    [userId, slug],
  );
  return rows[0].id;
}

type TxOptions = {
  accountId: string;
  amount: number;
  kind?: string;
  categoryId?: string | null;
  hash?: string;
};

let counter = 0;

function insertAs(db: PGlite, userId: string, options: TxOptions) {
  counter += 1;
  return db.query<{ id: string }>(
    `insert into public.transactions
       (user_id, account_id, category_id, posted_at, description, amount_cents, kind, dedupe_hash)
     values ($1, $2, $3, '2026-11-01', 'Teste', $4, $5::public.tx_kind, $6)
     returning id`,
    [
      userId,
      options.accountId,
      options.categoryId ?? null,
      options.amount,
      options.kind ?? "expense",
      options.hash ?? `tx:${counter}`,
    ],
  );
}

const createTransfer = (
  db: PGlite,
  from: string,
  to: string,
  amount: number,
  request = REQUEST_1,
) =>
  db.query<{ group_id: string }>(
    `select public.create_transfer($1, $2, $3, '2026-11-01', 'Transferência', null, $4) as group_id`,
    [from, to, amount, request],
  );

describe("migração dos lançamentos antigos", () => {
  let db: PGlite;
  let account: string;

  const legacy = async (kind: string, amount: number, hash: string) => {
    await db.query(
      `insert into public.transactions
         (user_id, account_id, posted_at, description, amount_cents, kind, dedupe_hash)
       values ($1, $2, '2026-10-01', 'Antigo', $3, $4::public.tx_kind, $5)`,
      [USER_A, account, amount, kind, hash],
    );
  };

  beforeAll(async () => {
    db = await createDatabase();
    await applyMigration(db, "0002_accounts.sql");
    await applyMigration(db, "0003_categories.sql");
    await createUser(db, USER_A, "a@teste.dev");
    account = await insertAccount(db, USER_A, "Conta", 100000);

    await legacy("pix_in", 5000, "pix_in");
    await legacy("pix_out", -1000, "pix_out");
    await legacy("debit", -200, "debit");
    await legacy("credit", -300, "credit");
    await legacy("income", 400, "income");
    await legacy("other", -500, "other_neg");
    await legacy("other", 600, "other_pos");
    await legacy("refund", 700, "refund");
    await legacy("transfer", -800, "transfer");
    await legacy("invoice_payment", -900, "invoice_payment");

    await applyMigration(db, "0004_transaction_types.sql");
    await applyMigration(db, "0005_transactions.sql");
  });

  const row = async (hash: string) => {
    const { rows } = await db.query<{ kind: string; payment_method: string | null }>(
      "select kind, payment_method from public.transactions where dedupe_hash = $1",
      [hash],
    );
    return rows[0];
  };

  it.each([
    ["pix_in", "income", "pix"],
    ["pix_out", "expense", "pix"],
    ["debit", "expense", "debit"],
    ["credit", "expense", "credit"],
    ["income", "income", null],
    ["other_neg", "expense", null],
    ["other_pos", "income", null],
    ["refund", "refund", null],
    ["transfer", "transfer", null],
    ["invoice_payment", "invoice_payment", null],
  ])("%s vira tipo %s e método %s", async (hash, kind, method) => {
    expect(await row(hash)).toEqual({ kind, payment_method: method });
  });

  it("não altera o saldo", async () => {
    // 100000 + soma dos dez lançamentos
    expect(await balanceOf(db, account)).toBe(100000 + 5000 - 1000 - 200 - 300 + 400 - 500 + 600 + 700 - 800 - 900);
  });

  it("lançamento antigo continua editável em campos sem relação com as regras", async () => {
    await db.query("update public.transactions set notes = 'ok' where dedupe_hash = 'transfer'");
    expect((await row("transfer")).kind).toBe("transfer");
  });
});

describe("regras de lançamentos", () => {
  let db: PGlite;
  let accountA: string;
  let accountA2: string;
  let accountB: string;

  beforeAll(async () => {
    db = await createDatabase();
    await migrateAll(db);
    await createUser(db, USER_A, "a@teste.dev");
    await createUser(db, USER_B, "b@teste.dev");
  });

  beforeEach(async () => {
    await db.exec("delete from public.transactions; delete from public.bank_accounts;");
    await db.exec("update public.transaction_categories set archived = false;");
    accountA = await insertAccount(db, USER_A, "Principal", 100000);
    accountA2 = await insertAccount(db, USER_A, "Reserva", 50000);
    accountB = await insertAccount(db, USER_B, "Conta de B", 70000);
  });

  describe("valor e tipo", () => {
    it("receita soma e despesa subtrai do saldo", async () => {
      await insertAs(db, USER_A, { accountId: accountA, amount: 5000, kind: "income" });
      await insertAs(db, USER_A, { accountId: accountA, amount: -2000, kind: "expense" });
      expect(await balanceOf(db, accountA)).toBe(103000);
    });

    it.each([
      ["zero", 0, "expense"],
      ["receita negativa", -100, "income"],
      ["despesa positiva", 100, "expense"],
    ])("rejeita %s", async (_label, amount, kind) => {
      await expect(insertAs(db, USER_A, { accountId: accountA, amount, kind })).rejects.toMatchObject({
        code: "WL004",
      });
      expect(await balanceOf(db, accountA)).toBe(100000);
    });

    it("rejeita trocar o tipo sem trocar o sinal", async () => {
      const { rows } = await insertAs(db, USER_A, { accountId: accountA, amount: -100 });
      await expect(
        db.query("update public.transactions set kind = 'income' where id = $1", [rows[0].id]),
      ).rejects.toMatchObject({ code: "WL004" });
    });

    it("trocar despesa por receita inverte o efeito no saldo", async () => {
      const { rows } = await insertAs(db, USER_A, { accountId: accountA, amount: -100 });
      await db.query(
        "update public.transactions set kind = 'income', amount_cents = 100 where id = $1",
        [rows[0].id],
      );
      expect(await balanceOf(db, accountA)).toBe(100100);
    });

    it("rejeita descrição vazia e valor fora do limite", async () => {
      await expect(
        db.query(
          `insert into public.transactions (user_id, account_id, posted_at, description, amount_cents, kind, dedupe_hash)
           values ($1, $2, '2026-11-01', '  ', -1, 'expense', 'vazia')`,
          [USER_A, accountA],
        ),
      ).rejects.toThrow(/description_length/);
      await expect(
        insertAs(db, USER_A, { accountId: accountA, amount: -100000000000001 }),
      ).rejects.toThrow(/amount_range/);
    });

    it("calcula amount_abs_cents e impede a escrita direta", async () => {
      const { rows } = await insertAs(db, USER_A, { accountId: accountA, amount: -2500 });
      const stored = await db.query<{ amount_abs_cents: string | number }>(
        "select amount_abs_cents from public.transactions where id = $1",
        [rows[0].id],
      );
      expect(Number(stored.rows[0].amount_abs_cents)).toBe(2500);
    });
  });

  describe("duplicidade", () => {
    it("o mesmo dedupe_hash não grava duas vezes nem altera o saldo", async () => {
      await insertAs(db, USER_A, { accountId: accountA, amount: -100, hash: "manual:x" });
      await expect(
        insertAs(db, USER_A, { accountId: accountA, amount: -100, hash: "manual:x" }),
      ).rejects.toMatchObject({ code: "23505" });
      expect(await balanceOf(db, accountA)).toBe(99900);
    });

    it("usuários diferentes podem usar a mesma chave", async () => {
      await insertAs(db, USER_A, { accountId: accountA, amount: -100, hash: "manual:y" });
      await insertAs(db, USER_B, { accountId: accountB, amount: -100, hash: "manual:y" });
    });
  });

  describe("compatibilidade com a categoria", () => {
    it("aceita categoria do mesmo tipo", async () => {
      await insertAs(db, USER_A, {
        accountId: accountA,
        amount: -100,
        kind: "expense",
        categoryId: await categoryId(db, USER_A, "lazer"),
      });
      await insertAs(db, USER_A, {
        accountId: accountA,
        amount: 100,
        kind: "income",
        categoryId: await categoryId(db, USER_A, "salario"),
      });
    });

    it("rejeita receita em categoria de despesa e vice-versa", async () => {
      await expect(
        insertAs(db, USER_A, {
          accountId: accountA,
          amount: 100,
          kind: "income",
          categoryId: await categoryId(db, USER_A, "lazer"),
        }),
      ).rejects.toMatchObject({ code: "WL001" });
      await expect(
        insertAs(db, USER_A, {
          accountId: accountA,
          amount: -100,
          kind: "expense",
          categoryId: await categoryId(db, USER_A, "salario"),
        }),
      ).rejects.toMatchObject({ code: "WL001" });
    });

    it("rejeita categoria em pagamento de fatura", async () => {
      await expect(
        insertAs(db, USER_A, {
          accountId: accountA,
          amount: -100,
          kind: "invoice_payment",
          categoryId: await categoryId(db, USER_A, "lazer"),
        }),
      ).rejects.toMatchObject({ code: "WL001" });
    });

    it("rejeita trocar o tipo mantendo a categoria incompatível", async () => {
      const { rows } = await insertAs(db, USER_A, {
        accountId: accountA,
        amount: -100,
        categoryId: await categoryId(db, USER_A, "lazer"),
      });
      await expect(
        db.query(
          "update public.transactions set kind = 'income', amount_cents = 100 where id = $1",
          [rows[0].id],
        ),
      ).rejects.toMatchObject({ code: "WL001" });
    });

    it("rejeita categoria arquivada em lançamento novo, mas mantém os antigos editáveis", async () => {
      const lazer = await categoryId(db, USER_A, "lazer");
      const { rows } = await insertAs(db, USER_A, {
        accountId: accountA,
        amount: -100,
        categoryId: lazer,
      });
      await db.query("update public.transaction_categories set archived = true where id = $1", [lazer]);

      await expect(
        insertAs(db, USER_A, { accountId: accountA, amount: -100, categoryId: lazer }),
      ).rejects.toMatchObject({ code: "WL002" });

      await db.query("update public.transactions set amount_cents = -200 where id = $1", [rows[0].id]);
      expect(await balanceOf(db, accountA)).toBe(99800);
    });
  });

  describe("conta arquivada", () => {
    it("não recebe lançamentos novos, mas os antigos seguem editáveis e excluíveis", async () => {
      const { rows } = await insertAs(db, USER_A, { accountId: accountA, amount: -100 });
      await db.query("update public.bank_accounts set archived = true where id = $1", [accountA]);

      await expect(
        insertAs(db, USER_A, { accountId: accountA, amount: -100 }),
      ).rejects.toMatchObject({ code: "WL003" });

      await db.query("update public.transactions set description = 'Editado' where id = $1", [rows[0].id]);
      await db.query("delete from public.transactions where id = $1", [rows[0].id]);
      expect(await balanceOf(db, accountA)).toBe(100000);
    });

    it("não recebe um lançamento movido de outra conta", async () => {
      const { rows } = await insertAs(db, USER_A, { accountId: accountA, amount: -100 });
      await db.query("update public.bank_accounts set archived = true where id = $1", [accountA2]);
      await expect(
        db.query("update public.transactions set account_id = $1 where id = $2", [accountA2, rows[0].id]),
      ).rejects.toMatchObject({ code: "WL003" });
    });
  });

  describe("transferências", () => {
    const asA = <T>(fn: () => Promise<T>) => asUser(db, USER_A, fn);

    const legs = async (group: string) => {
      const { rows } = await db.query<{
        account_id: string;
        amount_cents: string | number;
        kind: string;
        payment_method: string;
      }>(
        `select account_id, amount_cents, kind, payment_method
           from public.transactions where transfer_group_id = $1 order by amount_cents`,
        [group],
      );
      return rows;
    };

    it("debita uma conta, credita a outra e preserva o patrimônio", async () => {
      const { rows } = await asA(() => createTransfer(db, accountA, accountA2, 30000));

      expect(await balanceOf(db, accountA)).toBe(70000);
      expect(await balanceOf(db, accountA2)).toBe(80000);
      expect((await balanceOf(db, accountA)) + (await balanceOf(db, accountA2))).toBe(150000);

      const pair = await legs(rows[0].group_id);
      expect(pair).toHaveLength(2);
      expect(pair.map((l) => Number(l.amount_cents))).toEqual([-30000, 30000]);
      expect(pair.every((l) => l.kind === "transfer" && l.payment_method === "transfer")).toBe(true);
    });

    it("não entra como receita nem despesa", async () => {
      await asA(() => createTransfer(db, accountA, accountA2, 30000));
      const { rows } = await db.query<{ count: number }>(
        "select count(*)::int as count from public.transactions where kind in ('income', 'expense')",
      );
      expect(rows[0].count).toBe(0);
    });

    it("é idempotente pelo identificador da requisição", async () => {
      const first = await asA(() => createTransfer(db, accountA, accountA2, 30000));
      const second = await asA(() => createTransfer(db, accountA, accountA2, 30000));

      expect(second.rows[0].group_id).toBe(first.rows[0].group_id);
      expect(await balanceOf(db, accountA)).toBe(70000);
    });

    it("requisições diferentes criam transferências diferentes", async () => {
      await asA(() => createTransfer(db, accountA, accountA2, 100, REQUEST_1));
      await asA(() => createTransfer(db, accountA, accountA2, 100, REQUEST_2));
      expect(await balanceOf(db, accountA)).toBe(99800);
    });

    it.each([
      ["zero", 0],
      ["negativo", -100],
    ])("rejeita valor %s", async (_label, amount) => {
      await expect(
        asA(() => createTransfer(db, accountA, accountA2, amount)),
      ).rejects.toMatchObject({ code: "WL004" });
    });

    it("rejeita a mesma conta nos dois lados", async () => {
      await expect(
        asA(() => createTransfer(db, accountA, accountA, 100)),
      ).rejects.toMatchObject({ code: "WL005" });
      expect(await balanceOf(db, accountA)).toBe(100000);
    });

    it("não grava nada se uma das contas estiver arquivada", async () => {
      await db.query("update public.bank_accounts set archived = true where id = $1", [accountA2]);
      await expect(
        asA(() => createTransfer(db, accountA, accountA2, 100)),
      ).rejects.toMatchObject({ code: "WL003" });
      expect(await balanceOf(db, accountA)).toBe(100000);
    });

    it("rejeita conta de destino de outro usuário sem mexer em nenhum saldo", async () => {
      await expect(
        asA(() => createTransfer(db, accountA, accountB, 100)),
      ).rejects.toMatchObject({ code: "23503" });
      expect(await balanceOf(db, accountA)).toBe(100000);
      expect(await balanceOf(db, accountB)).toBe(70000);
    });

    it("exige usuário autenticado", async () => {
      await db.exec("select set_config('request.jwt.claim.sub', '', false)");
      await expect(createTransfer(db, accountA, accountA2, 100)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("update_transfer altera valor e contas, mantendo o patrimônio", async () => {
      const third = await insertAccount(db, USER_A, "Terceira", 0);
      const { rows } = await asA(() => createTransfer(db, accountA, accountA2, 30000));

      await asA(() =>
        db.query(
          `select public.update_transfer($1, $2, $3, 5000, '2026-11-02', 'Nova', 'Obs')`,
          [rows[0].group_id, accountA, third],
        ),
      );

      expect(await balanceOf(db, accountA)).toBe(95000);
      expect(await balanceOf(db, accountA2)).toBe(50000);
      expect(await balanceOf(db, third)).toBe(5000);
    });

    it("update_transfer rejeita grupo inexistente ou de outro usuário", async () => {
      const { rows } = await asA(() => createTransfer(db, accountA, accountA2, 100));
      await expect(
        asUser(db, USER_B, () =>
          db.query(
            `select public.update_transfer($1, $2, $3, 5000, '2026-11-02', 'X', null)`,
            [rows[0].group_id, accountB, accountA],
          ),
        ),
      ).rejects.toMatchObject({ code: "P0002" });
      expect(await balanceOf(db, accountA)).toBe(99900);
    });

    it("excluir os dois lados juntos restaura os saldos", async () => {
      const { rows } = await asA(() => createTransfer(db, accountA, accountA2, 30000));
      await asA(() =>
        db.query("delete from public.transactions where transfer_group_id = $1", [rows[0].group_id]),
      );
      expect(await balanceOf(db, accountA)).toBe(100000);
      expect(await balanceOf(db, accountA2)).toBe(50000);
    });

    describe("nenhum caminho deixa o par inconsistente", () => {
      let group: string;

      beforeEach(async () => {
        const { rows } = await asA(() => createTransfer(db, accountA, accountA2, 30000));
        group = rows[0].group_id;
      });

      const expectRejected = async (sql: string, params: unknown[]) => {
        await db.exec("begin");
        await db.query(sql, params);
        await expect(db.exec("commit")).rejects.toMatchObject({ code: "WL005" });
        expect(await balanceOf(db, accountA)).toBe(70000);
        expect(await balanceOf(db, accountA2)).toBe(80000);
      };

      it("excluir só um lado", () =>
        expectRejected(
          "delete from public.transactions where transfer_group_id = $1 and amount_cents < 0",
          [group],
        ));

      it("alterar o valor de um lado só", () =>
        expectRejected(
          "update public.transactions set amount_cents = -1 where transfer_group_id = $1 and amount_cents < 0",
          [group],
        ));

      it("alterar a data de um lado só", () =>
        expectRejected(
          "update public.transactions set posted_at = '2026-01-01' where transfer_group_id = $1 and amount_cents < 0",
          [group],
        ));

      it("colocar os dois lados na mesma conta", () =>
        expectRejected(
          "update public.transactions set account_id = $1 where transfer_group_id = $2 and amount_cents > 0",
          [accountA, group],
        ));

      it("acrescentar um terceiro lançamento ao grupo", () =>
        expectRejected(
          `insert into public.transactions
             (user_id, account_id, posted_at, description, amount_cents, kind, transfer_group_id, dedupe_hash)
           values ($1, $2, '2026-11-01', 'Extra', 1, 'transfer', $3, 'extra')`,
          [USER_A, accountA, group],
        ));
    });

    it("rejeita lançamento único do tipo transferência, com ou sem grupo", async () => {
      await expect(
        insertAs(db, USER_A, { accountId: accountA, amount: -100, kind: "transfer" }),
      ).rejects.toMatchObject({ code: "WL005" });

      await db.exec("begin");
      await db.query(
        `insert into public.transactions
           (user_id, account_id, posted_at, description, amount_cents, kind, transfer_group_id, dedupe_hash)
         values ($1, $2, '2026-11-01', 'Sozinha', -100, 'transfer', gen_random_uuid(), 'sozinha')`,
        [USER_A, accountA],
      );
      await expect(db.exec("commit")).rejects.toMatchObject({ code: "WL005" });
      expect(await balanceOf(db, accountA)).toBe(100000);
    });

    it("rejeita grupo em lançamento que não é transferência", async () => {
      await expect(
        db.query(
          `insert into public.transactions
             (user_id, account_id, posted_at, description, amount_cents, kind, transfer_group_id, dedupe_hash)
           values ($1, $2, '2026-11-01', 'X', -100, 'expense', gen_random_uuid(), 'x')`,
          [USER_A, accountA],
        ),
      ).rejects.toMatchObject({ code: "WL005" });
    });
  });

  describe("isolamento entre usuários", () => {
    it("B não lê, altera nem exclui lançamentos de A", async () => {
      const { rows } = await insertAs(db, USER_A, { accountId: accountA, amount: -100 });
      await asUser(db, USER_B, async () => {
        const visible = await db.query("select 1 from public.transactions where id = $1", [rows[0].id]);
        const updated = await db.query(
          "update public.transactions set amount_cents = -999 where id = $1",
          [rows[0].id],
        );
        const deleted = await db.query("delete from public.transactions where id = $1", [rows[0].id]);
        expect(visible.rows).toHaveLength(0);
        expect(updated.affectedRows).toBe(0);
        expect(deleted.affectedRows).toBe(0);
      });
      expect(await balanceOf(db, accountA)).toBe(99900);
    });

    it("B não grava lançamento na conta de A pelo cliente autenticado", async () => {
      await asUser(db, USER_B, async () => {
        await expect(
          insertAs(db, USER_B, { accountId: accountA, amount: 999, kind: "income" }),
        ).rejects.toMatchObject({ code: "23503" });
      });
      expect(await balanceOf(db, accountA)).toBe(100000);
    });

    it("anon não chama as funções de transferência", async () => {
      await asAnon(db, async () => {
        await expect(createTransfer(db, accountA, accountA2, 100)).rejects.toThrow(/permission denied/);
      });
    });

    it("o cliente não chama as funções internas", async () => {
      await asUser(db, USER_A, async () => {
        await expect(
          db.query("select public.transactions_check_transfer_group(gen_random_uuid())"),
        ).rejects.toThrow(/permission denied/);
      });
    });
  });

  it("não impede a exclusão em cascata de um usuário com transferências", async () => {
    const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await createUser(db, userId, "c@teste.dev");
    const from = await insertAccount(db, userId, "Origem", 1000);
    const to = await insertAccount(db, userId, "Destino", 0);
    await asUser(db, userId, () => createTransfer(db, from, to, 100));

    await db.query("delete from auth.users where id = $1", [userId]);

    const { rows } = await db.query("select 1 from public.transactions where user_id = $1", [userId]);
    expect(rows).toHaveLength(0);
  });
});
