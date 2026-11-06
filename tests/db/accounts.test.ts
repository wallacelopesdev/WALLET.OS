import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  USER_A,
  USER_B,
  applyAccountsMigration,
  asAnon,
  asUser,
  balanceOf,
  createDatabase,
  createUser,
  insertAccount,
  insertTx,
} from "./harness";

describe("migration 0002 sobre dados existentes", () => {
  let db: PGlite;
  let withTx: string;
  let withoutTx: string;

  beforeAll(async () => {
    db = await createDatabase();
    await createUser(db, USER_A, "a@teste.dev");

    // Estado da Fase 1: saldo digitado à mão no Table Editor.
    const { rows } = await db.query<{ id: string }>(
      `insert into public.bank_accounts (user_id, institution, name, balance_cents)
       values ($1, 'Banco', 'Com movimentos', 100000), ($1, '  ', 'Sem movimentos', 2550)
       returning id`,
      [USER_A],
    );
    withTx = rows[0].id;
    withoutTx = rows[1].id;
    await insertTx(db, USER_A, withTx, -20000);
    await insertTx(db, USER_A, withTx, 5000);

    await applyAccountsMigration(db);
  });

  it("preserva o saldo atual de cada conta", async () => {
    expect(await balanceOf(db, withTx)).toBe(100000);
    expect(await balanceOf(db, withoutTx)).toBe(2550);
  });

  it("calcula o saldo inicial que explica o saldo atual", async () => {
    const { rows } = await db.query<{ opening_balance_cents: string | number }>(
      "select opening_balance_cents from public.bank_accounts where id = $1",
      [withTx],
    );
    expect(Number(rows[0].opening_balance_cents)).toBe(115000);
  });

  it("normaliza instituição em branco para nulo", async () => {
    const { rows } = await db.query<{ institution: string | null }>(
      "select institution from public.bank_accounts where id = $1",
      [withoutTx],
    );
    expect(rows[0].institution).toBeNull();
  });

  it("os novos tipos de conta ficam disponíveis após o commit", async () => {
    for (const kind of ["digital", "cash", "investment", "other", "wallet"]) {
      await expect(
        insertAccount(db, USER_A, `Conta ${kind}`, 0, kind),
      ).resolves.toBeTruthy();
    }
  });
});

describe("a migration aborta sem alterar nada", () => {
  it("quando uma transação aponta para a conta de outro usuário", async () => {
    const db = await createDatabase();
    await createUser(db, USER_A, "a@teste.dev");
    await createUser(db, USER_B, "b@teste.dev");
    const { rows } = await db.query<{ id: string }>(
      `insert into public.bank_accounts (user_id, institution, name, balance_cents)
       values ($1, 'Banco', 'Conta de A', 1000) returning id`,
      [USER_A],
    );
    await insertTx(db, USER_B, rows[0].id, -100);

    await expect(applyAccountsMigration(db)).rejects.toThrow();
    await db.exec("rollback");

    const column = await db.query(
      `select 1 from information_schema.columns
        where table_name = 'bank_accounts' and column_name = 'opening_balance_cents'`,
    );
    expect(column.rows).toHaveLength(0);
    expect(await balanceOf(db, rows[0].id)).toBe(1000);
  });
});

describe("regras do schema migrado", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDatabase();
    await applyAccountsMigration(db);
    await createUser(db, USER_A, "a@teste.dev");
    await createUser(db, USER_B, "b@teste.dev");
  });

  beforeEach(async () => {
    await db.exec("delete from public.transactions; delete from public.bank_accounts;");
  });

  describe("saldo", () => {
    it("nasce igual ao saldo inicial, mesmo se o cliente informar outro", async () => {
      const id = await insertAccount(db, USER_A, "Conta", 12345);
      expect(await balanceOf(db, id)).toBe(12345);

      const { rows } = await db.query<{ id: string }>(
        `insert into public.bank_accounts
           (user_id, institution, name, opening_balance_cents, balance_cents)
         values ($1, 'B', 'Forjada', 100, 999999) returning id`,
        [USER_A],
      );
      expect(await balanceOf(db, rows[0].id)).toBe(100);
    });

    it("aceita saldo inicial negativo (cheque especial)", async () => {
      const id = await insertAccount(db, USER_A, "Conta", -5000);
      expect(await balanceOf(db, id)).toBe(-5000);
    });

    it("segue insert, update e delete de transações", async () => {
      const id = await insertAccount(db, USER_A, "Conta", 10000);

      const tx = await insertTx(db, USER_A, id, -2500);
      expect(await balanceOf(db, id)).toBe(7500);

      await db.query("update public.transactions set amount_cents = -4000 where id = $1", [tx]);
      expect(await balanceOf(db, id)).toBe(6000);

      await db.query("delete from public.transactions where id = $1", [tx]);
      expect(await balanceOf(db, id)).toBe(10000);
    });

    it("move o valor ao trocar a transação de conta", async () => {
      const from = await insertAccount(db, USER_A, "Origem", 10000);
      const to = await insertAccount(db, USER_A, "Destino", 0);
      const tx = await insertTx(db, USER_A, from, -1000);

      await db.query("update public.transactions set account_id = $1 where id = $2", [to, tx]);

      expect(await balanceOf(db, from)).toBe(10000);
      expect(await balanceOf(db, to)).toBe(-1000);
    });

    it("não é afetado por edições que não mudam conta nem valor", async () => {
      const id = await insertAccount(db, USER_A, "Conta", 1000);
      const tx = await insertTx(db, USER_A, id, -100);
      await db.query("update public.transactions set description = 'Outra' where id = $1", [tx]);
      expect(await balanceOf(db, id)).toBe(900);
    });

    it("par débito/crédito de transferência não altera o patrimônio", async () => {
      const from = await insertAccount(db, USER_A, "Origem", 50000);
      const to = await insertAccount(db, USER_A, "Destino", 10000);

      await insertTx(db, USER_A, from, -20000);
      await insertTx(db, USER_A, to, 20000);

      expect(await balanceOf(db, from)).toBe(30000);
      expect(await balanceOf(db, to)).toBe(30000);
      expect((await balanceOf(db, from)) + (await balanceOf(db, to))).toBe(60000);
    });

    it("editar o saldo inicial desloca o saldo pela diferença", async () => {
      const id = await insertAccount(db, USER_A, "Conta", 1000);
      await insertTx(db, USER_A, id, -300);

      await db.query(
        "update public.bank_accounts set opening_balance_cents = 5000 where id = $1",
        [id],
      );

      expect(await balanceOf(db, id)).toBe(4700);
    });

    it("mantém a invariante após uma sequência de operações", async () => {
      const id = await insertAccount(db, USER_A, "Conta", 777);
      const txs = [];
      for (const amount of [100, -250, 999, -1, 40]) {
        txs.push(await insertTx(db, USER_A, id, amount));
      }
      await db.query("delete from public.transactions where id = $1", [txs[1]]);
      await db.query("update public.transactions set amount_cents = 500 where id = $1", [txs[2]]);

      const { rows } = await db.query<{ ok: boolean }>(
        `select a.balance_cents = a.opening_balance_cents + coalesce(sum(t.amount_cents), 0) as ok
           from public.bank_accounts a
           left join public.transactions t on t.account_id = a.id
          where a.id = $1
          group by a.id`,
        [id],
      );
      expect(rows[0].ok).toBe(true);
    });

    it("ignora escrita direta até para role privilegiada", async () => {
      const id = await insertAccount(db, USER_A, "Conta", 1000);
      await db.query("update public.bank_accounts set balance_cents = 999999 where id = $1", [id]);
      expect(await balanceOf(db, id)).toBe(1000);
    });

    it("nega ao cliente a escrita em balance_cents", async () => {
      const id = await insertAccount(db, USER_A, "Conta", 1000);
      await asUser(db, USER_A, async () => {
        await expect(
          db.query("update public.bank_accounts set balance_cents = 999999 where id = $1", [id]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.query(
            `insert into public.bank_accounts (user_id, name, balance_cents)
             values ($1, 'Forjada', 999999)`,
            [USER_A],
          ),
        ).rejects.toThrow(/permission denied/);
      });
      expect(await balanceOf(db, id)).toBe(1000);
    });

    it("rejeita saldo inicial fora do limite", async () => {
      await expect(
        insertAccount(db, USER_A, "Conta", 100000000000001),
      ).rejects.toThrow(/bank_accounts_opening_balance_range/);
    });
  });

  describe("campos", () => {
    it("rejeita nome vazio e aceita instituição nula", async () => {
      await expect(insertAccount(db, USER_A, "   ")).rejects.toThrow(
        /bank_accounts_name_length/,
      );
      await expect(
        db.query(
          "insert into public.bank_accounts (user_id, name, kind) values ($1, 'Carteira', 'wallet')",
          [USER_A],
        ),
      ).resolves.toBeTruthy();
    });
  });

  describe("exclusão", () => {
    it("bloqueia conta com movimentações e mantém os dados", async () => {
      const id = await insertAccount(db, USER_A, "Conta", 1000);
      await insertTx(db, USER_A, id, -100);

      await asUser(db, USER_A, async () => {
        await expect(
          db.query("delete from public.bank_accounts where id = $1", [id]),
        ).rejects.toMatchObject({ code: "23503" });
      });

      expect(await balanceOf(db, id)).toBe(900);
    });

    it("permite conta sem movimentações", async () => {
      const id = await insertAccount(db, USER_A, "Conta");
      await asUser(db, USER_A, () =>
        db.query("delete from public.bank_accounts where id = $1", [id]),
      );
      const { rows } = await db.query("select 1 from public.bank_accounts where id = $1", [id]);
      expect(rows).toHaveLength(0);
    });

    it("não impede a exclusão em cascata de um usuário", async () => {
      const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      await createUser(db, userId, "c@teste.dev");
      const id = await insertAccount(db, userId, "Conta", 1000);
      await insertTx(db, userId, id, -100);

      await db.query("delete from auth.users where id = $1", [userId]);

      const accounts = await db.query("select 1 from public.bank_accounts where user_id = $1", [userId]);
      const txs = await db.query("select 1 from public.transactions where user_id = $1", [userId]);
      expect(accounts.rows).toHaveLength(0);
      expect(txs.rows).toHaveLength(0);
    });
  });

  describe("isolamento entre usuários", () => {
    let accountA: string;

    beforeEach(async () => {
      accountA = await insertAccount(db, USER_A, "Conta de A", 1000);
      await insertTx(db, USER_A, accountA, -100);
    });

    it("o dono acessa a própria conta pelo cliente autenticado", async () => {
      await asUser(db, USER_A, async () => {
        const created = await db.query<{ id: string }>(
          `insert into public.bank_accounts (user_id, institution, name, opening_balance_cents)
           values ($1, 'B', 'Nova', 500) returning id`,
          [USER_A],
        );
        await db.query(
          "update public.bank_accounts set name = 'Renomeada', archived = true where id = $1",
          [created.rows[0].id],
        );
        const { rows } = await db.query("select id from public.bank_accounts");
        expect(rows).toHaveLength(2);
      });
    });

    it("B não lê contas nem transações de A", async () => {
      await asUser(db, USER_B, async () => {
        const accounts = await db.query("select id from public.bank_accounts");
        const txs = await db.query("select id from public.transactions");
        expect(accounts.rows).toHaveLength(0);
        expect(txs.rows).toHaveLength(0);
      });
    });

    it("B não altera nem exclui a conta de A", async () => {
      await asUser(db, USER_B, async () => {
        const updated = await db.query(
          "update public.bank_accounts set name = 'Invadida', archived = true where id = $1",
          [accountA],
        );
        const deleted = await db.query("delete from public.bank_accounts where id = $1", [accountA]);
        expect(updated.affectedRows).toBe(0);
        expect(deleted.affectedRows).toBe(0);
      });

      const { rows } = await db.query<{ name: string; archived: boolean }>(
        "select name, archived from public.bank_accounts where id = $1",
        [accountA],
      );
      expect(rows[0]).toEqual({ name: "Conta de A", archived: false });
    });

    it("B não cria conta em nome de A", async () => {
      await asUser(db, USER_B, async () => {
        await expect(
          db.query("insert into public.bank_accounts (user_id, name) values ($1, 'X')", [USER_A]),
        ).rejects.toThrow(/row-level security/);
      });
    });

    it("B não consegue mexer no saldo de A com uma transação apontando para a conta dele", async () => {
      await asUser(db, USER_B, async () => {
        await expect(
          db.query(
            `insert into public.transactions
               (user_id, account_id, posted_at, description, amount_cents, dedupe_hash)
             values ($1, $2, '2026-11-01', 'Ataque', 999999, 'ataque')`,
            [USER_B, accountA],
          ),
        ).rejects.toMatchObject({ code: "23503" });
      });
      expect(await balanceOf(db, accountA)).toBe(900);
    });

    it("B não consegue redirecionar a própria transação para a conta de A", async () => {
      const accountB = await insertAccount(db, USER_B, "Conta de B", 0);
      const txB = await insertTx(db, USER_B, accountB, 700);

      await asUser(db, USER_B, async () => {
        await expect(
          db.query("update public.transactions set account_id = $1 where id = $2", [accountA, txB]),
        ).rejects.toMatchObject({ code: "23503" });
      });

      expect(await balanceOf(db, accountA)).toBe(900);
      expect(await balanceOf(db, accountB)).toBe(700);
    });

    it("anon não acessa nenhuma tabela financeira", async () => {
      await asAnon(db, async () => {
        await expect(db.query("select id from public.bank_accounts")).rejects.toThrow(
          /permission denied/,
        );
        await expect(db.query("select id from public.transactions")).rejects.toThrow(
          /permission denied/,
        );
      });
    });

    it("o cliente não chama as funções de trigger diretamente", async () => {
      await asUser(db, USER_A, async () => {
        await expect(
          db.query("select public.transactions_sync_balance()"),
        ).rejects.toThrow();
      });
    });
  });
});
