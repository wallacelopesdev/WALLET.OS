import { createHash } from "node:crypto";
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

const TOKEN_A = "wos_token_de_a";
const TOKEN_B = "wos_token_de_b";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

type Ingest = {
  token?: string | null;
  source?: string;
  ref?: string | null;
  description?: string;
  amount: number;
  date?: string;
  method?: string | null;
  hint?: string | null;
  last4?: string | null;
  account?: string | null;
  card?: string | null;
  location?: string | null;
  reason?: string | null;
};

describe("captura automática", () => {
  let db: PGlite;
  let account: string;
  let card: string;

  const ingest = async (i: Ingest) => {
    const { rows } = await db.query<{ r: { status: string; transaction_id?: string; reason?: string } }>(
      `select public.ingest_capture($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as r`,
      [
        i.token === undefined ? TOKEN_A : i.token,
        i.source ?? "apple_pay",
        i.ref ?? null,
        i.description ?? "Padaria",
        i.amount,
        i.date ?? "2026-11-05",
        i.method ?? null,
        i.hint ?? null,
        i.last4 ?? null,
        i.account ?? null,
        i.card ?? null,
        i.location ?? null,
        i.reason ?? null,
      ],
    );
    return rows[0].r;
  };

  const count = async (table: string) => {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`);
    return rows[0].n;
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
    ]) {
      await applyMigration(db, file);
    }
    await createUser(db, USER_A, "a@teste.dev");
    await createUser(db, USER_B, "b@teste.dev");
    await db.query(
      `insert into public.capture_tokens (user_id, name, token_hash) values ($1,'iPhone',$2), ($3,'iPhone B',$4)`,
      [USER_A, sha(TOKEN_A), USER_B, sha(TOKEN_B)],
    );
  });

  beforeEach(async () => {
    await db.exec(`
      delete from public.capture_events;
      delete from public.pluggy_links;
      delete from public.transactions;
      delete from public.card_installments;
      delete from public.card_invoices;
      delete from public.credit_cards;
      delete from public.bank_accounts;
      update public.capture_tokens set revoked_at = null;
    `);
    account = await insertAccount(db, USER_A, "Conta Itaú", 100000);
    await db.query("update public.bank_accounts set institution = 'Itaú' where id = $1", [account]);
    const { rows } = await db.query<{ id: string }>(
      `insert into public.credit_cards (user_id, institution, name, last4, limit_cents, closing_day, due_day)
       values ($1, 'Nubank', 'Roxinho', '1234', 500000, 10, 20) returning id`,
      [USER_A],
    );
    card = rows[0].id;
  });

  describe("autenticação", () => {
    it("recusa token inválido, revogado ou ausente", async () => {
      await expect(ingest({ token: "errado", amount: -100, hint: "Nubank" })).rejects.toMatchObject({
        code: "42501",
      });
      await db.query("update public.capture_tokens set revoked_at = now() where user_id = $1", [USER_A]);
      await expect(ingest({ amount: -100, hint: "Nubank" })).rejects.toMatchObject({ code: "42501" });
      await expect(ingest({ token: null, amount: -100, hint: "Nubank" })).rejects.toMatchObject({
        code: "42501",
      });
      expect(await count("transactions")).toBe(0);
    });

    it("anon com token válido consegue, sem token não", async () => {
      await asAnon(db, async () => {
        const result = await ingest({ amount: -100, hint: "Nubank" });
        expect(result.status).toBe("created");
        await expect(ingest({ token: null, amount: -100 })).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("anon não lê tokens nem eventos", async () => {
      await asAnon(db, async () => {
        await expect(db.query("select * from public.capture_tokens")).rejects.toThrow(/permission denied/);
        await expect(db.query("select * from public.capture_events")).rejects.toThrow(/permission denied/);
      });
    });

    it("o cliente não lê o hash do token e só altera a revogação", async () => {
      await asUser(db, USER_A, async () => {
        await expect(db.query("select token_hash from public.capture_tokens")).rejects.toThrow(/permission denied/);
        await expect(
          db.query("update public.capture_tokens set user_id = $1", [USER_B]),
        ).rejects.toThrow(/permission denied/);
        await db.query("update public.capture_tokens set revoked_at = now()");
      });
    });

    it("registra o último uso", async () => {
      await ingest({ amount: -100, hint: "Nubank" });
      const { rows } = await db.query<{ last_used_at: Date | null }>(
        "select last_used_at from public.capture_tokens where user_id = $1",
        [USER_A],
      );
      expect(rows[0].last_used_at).not.toBeNull();
    });
  });

  describe("destino", () => {
    it("compra com a dica do cartão entra na fatura, sem mexer em conta", async () => {
      const result = await ingest({ amount: -2500, hint: "Nubank Ultravioleta" });
      expect(result.status).toBe("created");
      expect(await balanceOf(db, account)).toBe(100000);
      const { rows } = await db.query<{ total_cents: number; closing_date: string }>(
        "select total_cents from public.card_invoices where card_id = $1",
        [card],
      );
      expect(Number(rows[0].total_cents)).toBe(2500);
    });

    it("os últimos dígitos identificam o cartão", async () => {
      expect((await ingest({ amount: -100, last4: "1234", method: "credit" })).status).toBe("created");
      const other = await ingest({ amount: -100, description: "Outra", last4: "9999", method: "credit" });
      expect(other.status).toBe("pending");
    });

    it("débito e Pix vão para a conta, nunca para o cartão", async () => {
      expect((await ingest({ amount: -1000, hint: "Itaú", method: "debit" })).status).toBe("created");
      expect((await ingest({ amount: -2000, hint: "Itaú", method: "pix", description: "Maria" })).status).toBe("created");
      expect(await balanceOf(db, account)).toBe(97000);
      const nubankPix = await ingest({ amount: -300, hint: "Nubank", method: "pix", description: "João" });
      expect(nubankPix.status).toBe("pending");
    });

    it("entrada soma no saldo como receita", async () => {
      await ingest({ amount: 5000, hint: "Itaú", method: "pix", description: "Cliente" });
      expect(await balanceOf(db, account)).toBe(105000);
      const { rows } = await db.query<{ kind: string; payment_method: string }>(
        "select kind, payment_method from public.transactions",
      );
      expect(rows[0]).toEqual({ kind: "income", payment_method: "pix" });
    });

    it("sem destino identificável fica pendente e não mexe em nada", async () => {
      const result = await ingest({ amount: -100, hint: "Banco Desconhecido" });
      expect(result).toMatchObject({ status: "pending" });
      expect(await count("transactions")).toBe(0);
      expect(await balanceOf(db, account)).toBe(100000);
    });

    it("dica ambígua fica pendente em vez de adivinhar", async () => {
      await db.query(
        `insert into public.credit_cards (user_id, institution, name, limit_cents, closing_day, due_day)
         values ($1, 'Nubank', 'Roxinho 2', 100, 10, 20)`,
        [USER_A],
      );
      expect((await ingest({ amount: -100, hint: "Nubank" })).status).toBe("pending");
    });

    it("conta e cartão arquivados não recebem", async () => {
      await db.query("update public.credit_cards set archived = true where id = $1", [card]);
      expect((await ingest({ amount: -100, hint: "Nubank" })).status).toBe("pending");
      expect((await ingest({ amount: -100, card, description: "Outra" })).status).toBe("pending");
    });

    it("estorno no cartão fica pendente", async () => {
      const result = await ingest({ amount: 500, card, source: "pluggy", ref: "x" });
      expect(result).toMatchObject({ status: "pending", reason: "Estorno ou crédito no cartão" });
    });

    it("motivo informado força a revisão", async () => {
      const result = await ingest({
        amount: -100,
        account,
        source: "pluggy",
        ref: "y",
        reason: "Possível transferência entre suas contas",
      });
      expect(result.status).toBe("pending");
      expect(await balanceOf(db, account)).toBe(100000);
    });

    it("guarda o local nas observações", async () => {
      await ingest({ amount: -100, hint: "Nubank", location: "Rua A, 10" });
      const { rows } = await db.query<{ notes: string }>("select notes from public.transactions");
      expect(rows[0].notes).toBe("Captura automática · Rua A, 10");
    });

    it("repete a categoria usada antes para a mesma descrição", async () => {
      const { rows } = await db.query<{ id: string }>(
        "select id from public.transaction_categories where user_id = $1 and slug = 'alimentacao'",
        [USER_A],
      );
      await db.query(
        `insert into public.transactions (user_id, account_id, category_id, posted_at, description, amount_cents, kind, dedupe_hash)
         values ($1, $2, $3, '2026-10-01', 'PADARIA', -1, 'expense', 'antiga')`,
        [USER_A, account, rows[0].id],
      );
      await ingest({ amount: -700, hint: "Nubank", description: "Padaria" });
      const { rows: created } = await db.query<{ category_id: string }>(
        "select category_id from public.transactions where card_id is not null",
      );
      expect(created[0].category_id).toBe(rows[0].id);
    });
  });

  describe("duplicidade", () => {
    it("o mesmo identificador externo só entra uma vez", async () => {
      await ingest({ amount: -100, account, source: "pluggy", ref: "tx1" });
      const again = await ingest({ amount: -100, account, source: "pluggy", ref: "tx1" });
      expect(again.status).toBe("duplicate");
      expect(await count("transactions")).toBe(1);
    });

    it("identificador pendente também não volta a entrar", async () => {
      await ingest({ amount: 100, card, source: "pluggy", ref: "tx2" });
      expect((await ingest({ amount: 100, card, source: "pluggy", ref: "tx2" })).status).toBe("duplicate");
    });

    it("atalho repetido na janela curta é ignorado", async () => {
      await ingest({ amount: -100, hint: "Nubank" });
      expect((await ingest({ amount: -100, hint: "Nubank" })).status).toBe("duplicate");
      expect(await count("transactions")).toBe(1);
    });

    it("Apple Pay seguido do banco no dia seguinte vira um lançamento só", async () => {
      const first = await ingest({ amount: -2500, hint: "Nubank", description: "PADARIA CENTRAL", date: "2026-11-05" });
      const second = await ingest({
        amount: -2500,
        card,
        source: "pluggy",
        ref: "p1",
        description: "Padaria Central LTDA",
        date: "2026-11-06",
      });
      expect(second).toEqual({ status: "matched", transaction_id: first.transaction_id });
      expect(await count("transactions")).toBe(1);
    });

    it("lançamento digitado à mão também é reconhecido", async () => {
      await db.query(
        `insert into public.transactions (user_id, account_id, posted_at, description, amount_cents, kind, dedupe_hash)
         values ($1, $2, '2026-11-05', 'Manual', -900, 'expense', 'manual:1')`,
        [USER_A, account],
      );
      const result = await ingest({ amount: -900, account, source: "pluggy", ref: "p2" });
      expect(result.status).toBe("matched");
      expect(await balanceOf(db, account)).toBe(99100);
    });

    it("duas compras iguais de verdade continuam sendo duas", async () => {
      await ingest({ amount: -500, account, source: "pluggy", ref: "a" });
      const second = await ingest({ amount: -500, account, source: "pluggy", ref: "b" });
      expect(second.status).toBe("created");
      expect(await balanceOf(db, account)).toBe(99000);
    });

    it("valor igual em datas distantes não é confundido", async () => {
      await ingest({ amount: -500, account, source: "apple_pay", date: "2026-11-01", hint: null });
      const later = await ingest({ amount: -500, account, source: "pluggy", ref: "c", date: "2026-11-05" });
      expect(later.status).toBe("created");
    });
  });

  describe("revisão", () => {
    const pendingId = async () => {
      const { rows } = await db.query<{ id: string }>(
        "select id from public.capture_events where status = 'pending' limit 1",
      );
      return rows[0].id;
    };

    it("registrar na conta atualiza o saldo e fecha a pendência", async () => {
      await ingest({ amount: -700, hint: "Banco Desconhecido" });
      const id = await pendingId();
      await asUser(db, USER_A, () => db.query("select public.resolve_capture($1, $2, null)", [id, account]));
      expect(await balanceOf(db, account)).toBe(99300);
      const { rows } = await db.query<{ status: string }>("select status from public.capture_events where id = $1", [id]);
      expect(rows[0].status).toBe("resolved");
    });

    it("registrar no cartão entra na fatura", async () => {
      await ingest({ amount: -700, hint: "Banco Desconhecido" });
      const id = await pendingId();
      await asUser(db, USER_A, () => db.query("select public.resolve_capture($1, null, $2)", [id, card]));
      const { rows } = await db.query<{ total_cents: number }>("select total_cents from public.card_invoices");
      expect(Number(rows[0].total_cents)).toBe(700);
    });

    it("entrada não vai para cartão e o destino é obrigatório", async () => {
      await ingest({ amount: 700, hint: "Banco Desconhecido" });
      const id = await pendingId();
      await expect(
        asUser(db, USER_A, () => db.query("select public.resolve_capture($1, null, $2)", [id, card])),
      ).rejects.toMatchObject({ code: "WL013" });
      await expect(
        asUser(db, USER_A, () => db.query("select public.resolve_capture($1, null, null)", [id])),
      ).rejects.toMatchObject({ code: "WL013" });
    });

    it("descartar não mexe em saldo e não permite reprocessar", async () => {
      await ingest({ amount: -700, hint: "Banco Desconhecido" });
      const id = await pendingId();
      await asUser(db, USER_A, () => db.query("select public.discard_capture($1)", [id]));
      await expect(
        asUser(db, USER_A, () => db.query("select public.resolve_capture($1, $2, null)", [id, account])),
      ).rejects.toMatchObject({ code: "P0002" });
      expect(await balanceOf(db, account)).toBe(100000);
    });

    it("excluir um lançamento capturado não o faz voltar na próxima sincronização", async () => {
      const result = await ingest({ amount: -100, account, source: "pluggy", ref: "z" });
      await db.query("delete from public.transactions where id = $1", [result.transaction_id]);
      expect((await ingest({ amount: -100, account, source: "pluggy", ref: "z" })).status).toBe("duplicate");
      expect(await count("transactions")).toBe(0);
    });
  });

  describe("isolamento entre usuários", () => {
    it("o token de B não grava na conta nem no cartão de A", async () => {
      const onAccount = await ingest({ token: TOKEN_B, amount: 999, account, source: "pluggy", ref: "b1" });
      const onCard = await ingest({ token: TOKEN_B, amount: -999, card, source: "pluggy", ref: "b2" });
      expect(onAccount.status).toBe("pending");
      expect(onCard.status).toBe("pending");
      expect(await balanceOf(db, account)).toBe(100000);
      expect(await count("transactions")).toBe(0);
    });

    it("a dica de B não encontra recursos de A", async () => {
      expect((await ingest({ token: TOKEN_B, amount: -1, hint: "Nubank" })).status).toBe("pending");
    });

    it("B não vê eventos de A nem resolve ou descarta", async () => {
      await ingest({ amount: -700, hint: "Banco Desconhecido" });
      const { rows } = await db.query<{ id: string }>("select id from public.capture_events limit 1");
      await asUser(db, USER_B, async () => {
        expect((await db.query("select 1 from public.capture_events")).rows).toHaveLength(0);
      });
      await expect(
        asUser(db, USER_B, () => db.query("select public.discard_capture($1)", [rows[0].id])),
      ).rejects.toMatchObject({ code: "P0002" });
      await expect(
        asUser(db, USER_B, () => db.query("select public.resolve_capture($1, $2, null)", [rows[0].id, account])),
      ).rejects.toMatchObject({ code: "P0002" });
    });

    it("B não liga conta da Pluggy a recurso de A", async () => {
      await asUser(db, USER_B, async () => {
        await expect(
          db.query(
            `insert into public.pluggy_links (user_id, pluggy_account_id, pluggy_type, label, account_id)
             values ($1, 'p', 'BANK', 'x', $2)`,
            [USER_B, account],
          ),
        ).rejects.toMatchObject({ code: "23503" });
      });
    });

    it("o cliente não escreve eventos nem chama funções internas", async () => {
      await asUser(db, USER_A, async () => {
        await expect(
          db.query(
            `insert into public.capture_events (user_id, source, description, amount_cents, event_date, status)
             values ($1, 'sms', 'x', 1, '2026-01-01', 'created')`,
            [USER_A],
          ),
        ).rejects.toThrow(/permission denied/);
        await expect(db.query("select public._capture_user('x')")).rejects.toThrow(/permission denied/);
      });
    });
  });

  describe("Pluggy", () => {
    it("só devolve vínculos do dono do token, a partir do dia do vínculo", async () => {
      await db.query(
        `insert into public.pluggy_links (user_id, pluggy_account_id, pluggy_type, label, account_id, linked_at)
         values ($1, 'acc', 'BANK', 'Conta', $2, '2026-10-15T12:00:00Z')`,
        [USER_A, account],
      );
      const { rows } = await db.query<{ pluggy_account_id: string; date_from: Date | string }>(
        "select pluggy_account_id, date_from::text as date_from from public.pluggy_sync_targets($1)",
        [TOKEN_A],
      );
      expect(rows).toEqual([{ pluggy_account_id: "acc", date_from: "2026-10-15" }]);
      const other = await db.query("select * from public.pluggy_sync_targets($1)", [TOKEN_B]);
      expect(other.rows).toHaveLength(0);
    });

    it("volta 3 dias depois de sincronizar, sem passar do dia do vínculo", async () => {
      await db.query(
        `insert into public.pluggy_links (user_id, pluggy_account_id, pluggy_type, label, account_id, linked_at, last_synced_at)
         values ($1, 'acc', 'BANK', 'Conta', $2, '2026-10-01T12:00:00Z', '2026-11-05T12:00:00Z'),
                ($1, 'acc2', 'BANK', 'Outra', $2, '2026-11-04T12:00:00Z', '2026-11-05T12:00:00Z')`,
        [USER_A, account],
      );
      const { rows } = await db.query<{ pluggy_account_id: string; date_from: string }>(
        "select pluggy_account_id, date_from::text as date_from from public.pluggy_sync_targets($1) order by 1",
        [TOKEN_A],
      );
      expect(rows.map((r) => r.date_from)).toEqual(["2026-11-02", "2026-11-04"]);
    });

    it("exige exatamente um destino por vínculo", async () => {
      await expect(
        db.query(
          `insert into public.pluggy_links (user_id, pluggy_account_id, pluggy_type, label, account_id, card_id)
           values ($1, 'x', 'BANK', 'x', $2, $3)`,
          [USER_A, account, card],
        ),
      ).rejects.toThrow();
    });
  });

  it("não impede excluir um usuário com tokens, eventos e vínculos", async () => {
    const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await createUser(db, userId, "c@teste.dev");
    const own = await insertAccount(db, userId, "Conta C");
    await db.query(
      `insert into public.capture_tokens (user_id, name, token_hash) values ($1, 't', 'hash-c')`,
      [userId],
    );
    await db.query(
      `insert into public.pluggy_links (user_id, pluggy_account_id, pluggy_type, label, account_id)
       values ($1, 'c', 'BANK', 'x', $2)`,
      [userId, own],
    );
    await db.query("delete from auth.users where id = $1", [userId]);
    const { rows } = await db.query("select 1 from public.capture_tokens where user_id = $1", [userId]);
    expect(rows).toHaveLength(0);
  });
});
