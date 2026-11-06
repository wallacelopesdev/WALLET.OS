import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  USER_A,
  USER_B,
  applyAccountsMigration,
  applyMigration,
  asAnon,
  asUser,
  createDatabase,
  createUser,
  insertAccount,
} from "./harness";

const CATEGORIES = "0003_categories.sql";

async function categoryId(db: PGlite, userId: string, slug: string) {
  const { rows } = await db.query<{ id: string }>(
    "select id from public.transaction_categories where user_id = $1 and slug = $2",
    [userId, slug],
  );
  return rows[0].id;
}

async function insertCategorizedTx(
  db: PGlite,
  userId: string,
  accountId: string,
  category: string,
  amount: number,
  date = "2026-11-10",
) {
  await db.query(
    `insert into public.transactions
       (user_id, account_id, category_id, posted_at, description, amount_cents, dedupe_hash)
     values ($1, $2, $3, $4, 'Teste', $5, gen_random_uuid()::text)`,
    [userId, accountId, category, date, amount],
  );
}

describe("migration 0003 sobre um usuário existente", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDatabase();
    await applyAccountsMigration(db);
    await createUser(db, USER_A, "a@teste.dev");

    // Usuário personalizou uma categoria e criou duas próprias.
    await db.query(
      "update public.transaction_categories set name = 'Uber' where user_id = $1 and slug = 'transporte'",
      [USER_A],
    );
    const { rows } = await db.query<{ id: string }>(
      `insert into public.transaction_categories (user_id, name, slug)
       values ($1, 'Aluguéis recebidos', 'alugueis'), ($1, 'Pets', 'pets') returning id`,
      [USER_A],
    );
    const account = await insertAccount(db, USER_A, "Conta");
    await insertCategorizedTx(db, USER_A, account, rows[0].id, 150000);
    await insertCategorizedTx(db, USER_A, account, rows[1].id, -3000);

    await applyMigration(db, CATEGORIES);
  });

  const rowOf = async (slug: string) => {
    const { rows } = await db.query<{
      name: string;
      kind: string;
      icon: string | null;
      is_system: boolean;
    }>(
      "select name, kind, icon, is_system from public.transaction_categories where user_id = $1 and slug = $2",
      [USER_A, slug],
    );
    return rows[0];
  };

  it("adiciona as categorias de receita e a de moradia", async () => {
    for (const slug of ["salario", "freelance", "investimentos", "vendas", "outros-recebimentos"]) {
      expect((await rowOf(slug)).kind).toBe("income");
    }
    expect((await rowOf("moradia")).kind).toBe("expense");
  });

  it("alinha os nomes padrão ainda não personalizados", async () => {
    expect((await rowOf("compras")).name).toBe("Compras");
    expect((await rowOf("contas-fixas")).name).toBe("Contas");
    expect((await rowOf("outros")).name).toBe("Outros gastos");
  });

  it("preserva o nome personalizado", async () => {
    expect((await rowOf("transporte")).name).toBe("Uber");
  });

  it("mantém as categorias originais que não estão na lista nova", async () => {
    for (const slug of ["mercado", "delivery", "jogos", "bobeiras"]) {
      expect((await rowOf(slug)).kind).toBe("expense");
    }
  });

  it("deduz o tipo das categorias próprias pelo uso", async () => {
    expect((await rowOf("alugueis")).kind).toBe("income");
    expect((await rowOf("pets")).kind).toBe("expense");
  });

  it("define ícone só nas categorias padrão", async () => {
    expect((await rowOf("salario")).icon).toBe("banknote");
    expect((await rowOf("pets")).icon).toBeNull();
  });
});

describe("regras de categorias", () => {
  let db: PGlite;
  let accountA: string;

  beforeAll(async () => {
    db = await createDatabase();
    await applyAccountsMigration(db);
    await applyMigration(db, CATEGORIES);
    await createUser(db, USER_A, "a@teste.dev");
    await createUser(db, USER_B, "b@teste.dev");
    accountA = await insertAccount(db, USER_A, "Conta de A");
  });

  it("novo usuário recebe exatamente a lista padrão", async () => {
    const { rows } = await db.query<{ kind: string; count: number }>(
      `select kind, count(*)::int as count from public.transaction_categories
        where user_id = $1 group by kind order by kind`,
      [USER_A],
    );
    expect(rows).toEqual([
      { kind: "income", count: 5 },
      { kind: "expense", count: 10 },
    ]);
  });

  it("o cliente cria, edita e arquiva a própria categoria", async () => {
    await asUser(db, USER_A, async () => {
      const { rows } = await db.query<{ id: string; is_system: boolean }>(
        `insert into public.transaction_categories (user_id, name, slug, kind, color, icon)
         values ($1, 'Viagens', 'viagens', 'expense', '#60a5fa', 'plane')
         returning id, is_system`,
        [USER_A],
      );
      expect(rows[0].is_system).toBe(false);
      await db.query(
        "update public.transaction_categories set name = 'Férias', archived = true where id = $1",
        [rows[0].id],
      );
      await db.query("delete from public.transaction_categories where id = $1", [rows[0].id]);
    });
  });

  it("o cliente não forja is_system nem troca o dono", async () => {
    const id = await categoryId(db, USER_A, "moradia");
    await asUser(db, USER_A, async () => {
      await expect(
        db.query(
          `insert into public.transaction_categories (user_id, name, slug, is_system)
           values ($1, 'X', 'x', true)`,
          [USER_A],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("update public.transaction_categories set user_id = $1 where id = $2", [USER_B, id]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("rejeita nome vazio, cor e ícone malformados", async () => {
    const insert = (name: string, color: string, icon: string) =>
      db.query(
        `insert into public.transaction_categories (user_id, name, slug, color, icon)
         values ($1, $2, gen_random_uuid()::text, $3, $4)`,
        [USER_A, name, color, icon],
      );
    await expect(insert("  ", "#ffffff", "tag")).rejects.toThrow(/name_length/);
    await expect(insert("A", "red", "tag")).rejects.toThrow(/color_format/);
    await expect(insert("A", "#ffffff", "<svg>")).rejects.toThrow(/icon_format/);
  });

  it("bloqueia a exclusão de categoria em uso", async () => {
    const id = await categoryId(db, USER_A, "lazer");
    await insertCategorizedTx(db, USER_A, accountA, id, -500);
    await asUser(db, USER_A, async () => {
      await expect(
        db.query("delete from public.transaction_categories where id = $1", [id]),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("trava o tipo da categoria em uso, mas não o da categoria sem uso", async () => {
    const used = await categoryId(db, USER_A, "lazer");
    const unused = await categoryId(db, USER_A, "educacao");
    await asUser(db, USER_A, async () => {
      await expect(
        db.query("update public.transaction_categories set kind = 'income' where id = $1", [used]),
      ).rejects.toMatchObject({ code: "WL006" });
      await db.query("update public.transaction_categories set kind = 'income' where id = $1", [unused]);
      await db.query("update public.transaction_categories set kind = 'expense' where id = $1", [unused]);
    });
  });

  it("category_totals soma o período e conta todo o histórico", async () => {
    const id = await categoryId(db, USER_A, "saude");
    await insertCategorizedTx(db, USER_A, accountA, id, -1000, "2026-11-01");
    await insertCategorizedTx(db, USER_A, accountA, id, -2500, "2026-11-30");
    await insertCategorizedTx(db, USER_A, accountA, id, -9900, "2026-10-31");
    await insertCategorizedTx(db, USER_A, accountA, id, 500, "2026-11-15"); // estorno

    const rows = await asUser(db, USER_A, async () => {
      const result = await db.query<{
        category_id: string;
        period_cents: string | number;
        period_count: string | number;
        total_count: string | number;
      }>("select * from public.category_totals('2026-11-01', '2026-11-30')");
      return result.rows;
    });

    const row = rows.find((r) => r.category_id === id)!;
    expect(Number(row.period_cents)).toBe(-3000);
    expect(Number(row.period_count)).toBe(3);
    expect(Number(row.total_count)).toBe(4);
  });

  describe("isolamento entre usuários", () => {
    it("B não lê, altera nem exclui categorias de A", async () => {
      const id = await categoryId(db, USER_A, "assinaturas");
      await asUser(db, USER_B, async () => {
        const visible = await db.query(
          "select 1 from public.transaction_categories where user_id = $1",
          [USER_A],
        );
        const updated = await db.query(
          "update public.transaction_categories set archived = true where id = $1",
          [id],
        );
        const deleted = await db.query(
          "delete from public.transaction_categories where id = $1",
          [id],
        );
        expect(visible.rows).toHaveLength(0);
        expect(updated.affectedRows).toBe(0);
        expect(deleted.affectedRows).toBe(0);
      });
    });

    it("B não usa a categoria de A em uma transação", async () => {
      const accountB = await insertAccount(db, USER_B, "Conta de B");
      const categoryA = await categoryId(db, USER_A, "assinaturas");
      await asUser(db, USER_B, async () => {
        await expect(
          db.query(
            `insert into public.transactions
               (user_id, account_id, category_id, posted_at, description, amount_cents, dedupe_hash)
             values ($1, $2, $3, '2026-11-01', 'Ataque', -100, 'ataque-cat')`,
            [USER_B, accountB, categoryA],
          ),
        ).rejects.toMatchObject({ code: "23503" });
      });
    });

    it("B não vê os totais de A", async () => {
      const rows = await asUser(db, USER_B, async () => {
        const result = await db.query(
          "select * from public.category_totals('2000-01-01', '2100-01-01')",
        );
        return result.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it("anon não executa category_totals", async () => {
      await asAnon(db, async () => {
        await expect(
          db.query("select * from public.category_totals('2000-01-01', '2100-01-01')"),
        ).rejects.toThrow(/permission denied/);
      });
    });
  });

  it("não impede a exclusão em cascata de um usuário", async () => {
    const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await createUser(db, userId, "c@teste.dev");
    const account = await insertAccount(db, userId, "Conta");
    await insertCategorizedTx(db, userId, account, await categoryId(db, userId, "lazer"), -100);

    await db.query("delete from auth.users where id = $1", [userId]);

    const { rows } = await db.query(
      "select 1 from public.transaction_categories where user_id = $1",
      [userId],
    );
    expect(rows).toHaveLength(0);
  });
});
