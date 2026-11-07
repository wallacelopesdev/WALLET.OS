import { createHash } from "node:crypto";
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

const TOKEN_A = "wos_token_a_automacoes";
const TOKEN_B = "wos_token_b_automacoes";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const TODAY = "2026-11-05"; // quinta-feira

describe("automações do agente", () => {
  let db: PGlite;
  let account: string;
  let counter = 0;

  const tx = async (
    description: string,
    amount: number,
    date: string,
    options: { kind?: string; category?: string | null } = {},
  ) => {
    counter += 1;
    const { rows } = await db.query<{ id: string }>(
      `insert into public.transactions (user_id, account_id, category_id, posted_at, description, amount_cents, kind, dedupe_hash)
       values ($1, $2, $3, $4, $5, $6, $7::public.tx_kind, $8) returning id`,
      [USER_A, account, options.category ?? null, date, description, amount, options.kind ?? "expense", `auto:${counter}`],
    );
    return rows[0].id;
  };

  const run = async (today = TODAY, token = TOKEN_A) => {
    const { rows } = await db.query<{ r: Record<string, unknown> }>(
      "select public.agent_run_automations($1, $2) as r",
      [token, today],
    );
    return rows[0].r;
  };

  const notifications = async (kind?: string) => {
    const { rows } = await db.query<{ kind: string; title: string; body: string; severity: string; dedupe_key: string }>(
      `select kind, title, body, severity, dedupe_key from public.notifications
        where user_id = $1 ${kind ? "and kind = $2" : ""} order by created_at`,
      kind ? [USER_A, kind] : [USER_A],
    );
    return rows;
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
      "0010_agent_connections.sql",
      "0011_agent_automations.sql",
    ]) {
      await applyMigration(db, file);
    }
    await createUser(db, USER_A, "a@teste.dev");
    await createUser(db, USER_B, "b@teste.dev");
    await db.query(
      "insert into public.capture_tokens (user_id, name, token_hash) values ($1,'A',$2), ($3,'B',$4)",
      [USER_A, sha(TOKEN_A), USER_B, sha(TOKEN_B)],
    );
  });

  beforeEach(async () => {
    await db.exec(`
      delete from public.notifications;
      delete from public.recurring_charges;
      delete from public.agent_settings;
      delete from public.agent_runs;
      delete from public.bills;
      delete from public.provider_connections;
      delete from public.transactions;
      delete from public.card_installments;
      delete from public.card_invoices;
      delete from public.credit_cards;
      delete from public.bank_accounts;
    `);
    account = await insertAccount(db, USER_A, "Conta", 10000000);
  });

  describe("recorrências", () => {
    const monthly = async (description = "NETFLIX.COM", amount = -3990) => {
      await tx(description, amount, "2026-08-10");
      await tx(description, amount, "2026-09-10");
      await tx(description, amount, "2026-10-10");
    };

    it("identifica cobrança mensal e estima a próxima", async () => {
      await monthly();
      expect(await run()).toMatchObject({ recurring: 1 });
      const { rows } = await db.query<Record<string, unknown>>(
        "select period, occurrences, next_date::text as next, amount_cents, normalized_key from public.recurring_charges",
      );
      expect(rows[0]).toMatchObject({ period: "monthly", occurrences: 3, next: "2026-11-10", normalized_key: "netflix" });
      expect(Number(rows[0].amount_cents)).toBe(3990);
      expect((await notifications("recurring"))[0].body).toContain("R$ 39,90");
    });

    it("identifica cobrança semanal", async () => {
      for (const date of ["2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29"]) {
        await tx("Academia Boa", -5000, date);
      }
      await run();
      const { rows } = await db.query<{ period: string; next: string }>(
        "select period, next_date::text as next from public.recurring_charges",
      );
      expect(rows[0]).toEqual({ period: "weekly", next: "2026-11-05" });
    });

    it("aceita pequena variação de valor", async () => {
      await tx("Enel", -10000, "2026-08-10");
      await tx("Enel", -11000, "2026-09-10");
      await tx("Enel", -11900, "2026-10-10");
      expect(await run()).toMatchObject({ recurring: 1 });
    });

    it.each([
      ["menos de 3 ocorrências", [["2026-09-10", -100], ["2026-10-10", -100]]],
      ["intervalo irregular", [["2026-08-01", -100], ["2026-08-20", -100], ["2026-10-10", -100]]],
      ["valor muito diferente", [["2026-08-10", -100], ["2026-09-10", -500], ["2026-10-10", -100]]],
    ] as const)("ignora %s", async (_label, rows) => {
      for (const [date, amount] of rows) await tx("Loja", amount, date);
      expect(await run()).toMatchObject({ recurring: 0 });
    });

    it("parcelas não contam como recorrência", async () => {
      await tx("Loja (1/3)", -100, "2026-08-10");
      await tx("Loja (2/3)", -100, "2026-09-10");
      await tx("Loja (3/3)", -100, "2026-10-10");
      expect(await run()).toMatchObject({ recurring: 0 });
    });

    it("avisa uma vez só, mas mantém a previsão atualizada", async () => {
      await monthly();
      await run();
      await tx("NETFLIX.COM", -3990, "2026-11-04");
      expect(await run()).toMatchObject({ recurring: 0 });
      const { rows } = await db.query<{ next: string; occurrences: number }>(
        "select next_date::text as next, occurrences from public.recurring_charges",
      );
      expect(rows[0]).toEqual({ next: "2026-12-04", occurrences: 4 });
    });

    it("dispensar é uma escolha sua e se mantém", async () => {
      await monthly();
      await run();
      await asUser(db, USER_A, () => db.query("update public.recurring_charges set dismissed = true"));
      await tx("NETFLIX.COM", -3990, "2026-11-04");
      await run();
      const { rows } = await db.query<{ dismissed: boolean }>("select dismissed from public.recurring_charges");
      expect(rows[0].dismissed).toBe(true);
    });
  });

  describe("despesa incomum", () => {
    const history = async (category: string) => {
      for (let i = 1; i <= 5; i += 1) {
        await tx(`Mercado ${i}`, -10000, `2026-10-0${i}`, { category });
      }
    };
    const mercado = async () => {
      const { rows } = await db.query<{ id: string }>(
        "select id from public.transaction_categories where user_id = $1 and slug = 'mercado'",
        [USER_A],
      );
      return rows[0].id;
    };

    it("alerta acima de 3 vezes a média da categoria", async () => {
      const category = await mercado();
      await history(category);
      await tx("Mercado Grande", -40000, TODAY, { category });
      expect(await run()).toMatchObject({ anomalies: 1 });
      const [alert] = await notifications("anomaly");
      expect(alert.severity).toBe("warning");
      expect(alert.body).toContain("R$ 400,00");
      expect(alert.body).toContain("R$ 100,00");
    });

    it.each([
      ["dentro do padrão", -20000],
      ["de valor pequeno", -9000],
    ])("não alerta despesa %s", async (_label, amount) => {
      const category = await mercado();
      await history(category);
      await tx("Mercado Grande", amount, TODAY, { category });
      expect(await run()).toMatchObject({ anomalies: 0 });
    });

    it("não alerta sem histórico suficiente", async () => {
      const category = await mercado();
      await tx("A", -1000, "2026-10-01", { category });
      await tx("Mercado Grande", -90000, TODAY, { category });
      expect(await run()).toMatchObject({ anomalies: 0 });
    });

    it("não alerta despesa antiga", async () => {
      const category = await mercado();
      await history(category);
      await tx("Mercado Grande", -90000, "2026-10-20", { category });
      expect(await run()).toMatchObject({ anomalies: 0 });
    });

    it("não repete", async () => {
      const category = await mercado();
      await history(category);
      await tx("Mercado Grande", -40000, TODAY, { category });
      await run();
      expect(await run()).toMatchObject({ anomalies: 0 });
    });
  });

  describe("possível cobrança duplicada", () => {
    it("avisa, sem alterar nenhum lançamento", async () => {
      await tx("Loja X", -5000, TODAY);
      await tx("LOJA X", -5000, TODAY);
      expect(await run()).toMatchObject({ duplicates: 1 });
      const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.transactions");
      expect(rows[0].n).toBe(2);
    });

    it("descrição ou valor diferentes não contam", async () => {
      await tx("Loja X", -5000, TODAY);
      await tx("Loja Y", -5000, TODAY);
      await tx("Loja X", -5001, TODAY);
      expect(await run()).toMatchObject({ duplicates: 0 });
    });
  });

  describe("vencimentos", () => {
    const card = async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.credit_cards (user_id, institution, name, limit_cents, closing_day, due_day)
         values ($1, 'B', 'Roxinho', 100000, 28, 5) returning id`,
        [USER_A],
      );
      return rows[0].id;
    };
    const invoice = async (cardId: string, month: string, closing: string, due: string, total = 5000, paid = 0) =>
      db.query(
        `insert into public.card_invoices (user_id, card_id, reference_month, closing_date, due_date, total_cents, paid_cents)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [USER_A, cardId, month, closing, due, total, paid],
      );

    it("fatura fechada perto do vencimento e atrasada", async () => {
      const id = await card();
      await invoice(id, "2026-10-01", "2026-10-28", "2026-11-08");
      await invoice(id, "2026-09-01", "2026-09-28", "2026-10-05");
      await run();
      const list = await notifications("invoice");
      expect(list.map((n) => [n.title, n.severity]).sort()).toEqual([
        ["Fatura atrasada", "critical"],
        ["Fatura perto do vencimento", "warning"],
      ]);
    });

    it("fatura paga ou ainda aberta não avisa", async () => {
      const id = await card();
      await invoice(id, "2026-10-01", "2026-10-28", "2026-11-08", 5000, 5000);
      await invoice(id, "2026-11-01", "2026-11-28", "2026-12-05");
      expect(await run()).toMatchObject({ deadlines: 0 });
    });

    it("boleto perto do vencimento, vencido, pago e dispensado", async () => {
      await db.query(
        `insert into public.bills (user_id, beneficiary, amount_cents, due_date, dismissed)
         values ($1, 'Perto', 100, '2026-11-08', false), ($1, 'Vencido', 100, '2026-11-01', false),
                ($1, 'Longe', 100, '2026-12-20', false), ($1, 'Dispensado', 100, '2026-11-08', true)`,
        [USER_A],
      );
      await run();
      expect((await notifications("bill")).map((n) => n.title).sort()).toEqual([
        "Boleto perto do vencimento",
        "Boleto vencido",
      ]);
    });

    it("autorização vencida, com erro ou vencendo", async () => {
      await db.query(
        `insert into public.provider_connections (user_id, provider, external_item_id, institution_name, status, consent_expires_at)
         values ($1, 'pluggy', 'i1', 'Itaú', 'expired', null),
                ($1, 'pluggy', 'i2', 'Nubank', 'error', null),
                ($1, 'pluggy', 'i3', 'Inter', 'active', '2026-11-20T00:00:00Z'),
                ($1, 'pluggy', 'i4', 'C6', 'active', '2027-10-20T00:00:00Z'),
                ($1, 'pluggy', 'i5', 'XP', 'disconnected', null)`,
        [USER_A],
      );
      await run();
      expect((await notifications("connection")).map((n) => n.title).sort()).toEqual([
        "Autorização do banco vencendo",
        "Autorização do banco vencida",
        "Falha ao sincronizar",
      ]);
    });
  });

  describe("resumos", () => {
    it("diário não conta transferência nem pagamento de fatura; estorno reduz", async () => {
      await tx("Salário", 500000, "2026-11-04", { kind: "income" });
      await tx("Mercado", -10000, "2026-11-04");
      await tx("Estorno", 2500, "2026-11-04", { kind: "refund" });
      await run();
      const [digest] = await notifications("digest");
      expect(digest.title).toBe("Resumo de ontem");
      expect(digest.body).toBe("Receitas: R$ 5.000,00. Despesas: R$ 75,00. 3 lançamentos.");
    });

    it("sem movimentos, não envia", async () => {
      expect(await run()).toMatchObject({ digests: 0 });
    });

    it("segunda-feira traz o semanal; dia primeiro traz o mensal", async () => {
      await tx("A", -100, "2026-10-31");
      await tx("B", -100, "2026-11-01");
      await run("2026-11-02"); // segunda
      expect((await notifications("digest")).map((n) => n.title)).toContain("Resumo da semana");
      await db.exec("delete from public.notifications");
      await run("2026-11-01"); // dia 1, domingo
      expect((await notifications("digest")).map((n) => n.title)).toContain("Resumo do mês");
    });

    it("rodar de novo no mesmo dia não repete", async () => {
      await tx("A", -100, "2026-11-04");
      await run();
      await run();
      expect(await notifications("digest")).toHaveLength(1);
    });
  });

  describe("controle", () => {
    it("pausado não faz nada", async () => {
      await tx("A", -100, "2026-11-04");
      await db.query("insert into public.agent_settings (user_id, paused) values ($1, true)", [USER_A]);
      expect(await run()).toEqual({ paused: true });
      expect(await notifications()).toHaveLength(0);
    });

    it("cada automação pode ser desligada", async () => {
      await tx("A", -100, "2026-11-04");
      await db.query(
        `insert into public.agent_settings (user_id, automations) values ($1, '{"digests": false}')`,
        [USER_A],
      );
      await run();
      expect(await notifications("digest")).toHaveLength(0);
    });

    it("registra a execução", async () => {
      await run();
      const { rows } = await db.query<{ status: string; kind: string }>("select status, kind from public.agent_runs");
      expect(rows).toEqual([{ status: "success", kind: "automations" }]);
    });

    it("não roda em paralelo", async () => {
      await db.query("insert into public.agent_runs (user_id, kind) values ($1, 'automations')", [USER_A]);
      expect(await run()).toEqual({ skipped: "already_running" });
    });

    it("automações nunca alteram lançamentos nem saldos", async () => {
      await tx("Netflix", -3990, "2026-08-10");
      await tx("Netflix", -3990, "2026-09-10");
      await tx("Netflix", -3990, "2026-10-10");
      const snapshot = "select id, amount_cents, kind, category_id, description from public.transactions order by id";
      const before = await db.query(snapshot);
      const balance = await db.query("select balance_cents from public.bank_accounts");
      await run();
      expect((await db.query(snapshot)).rows).toEqual(before.rows);
      expect((await db.query("select balance_cents from public.bank_accounts")).rows).toEqual(balance.rows);
    });
  });

  describe("isolamento", () => {
    it("o token de B não gera nada com os dados de A", async () => {
      await tx("A", -100, "2026-11-04");
      await run(TODAY, TOKEN_B);
      expect(await notifications()).toHaveLength(0);
    });

    it("B não vê avisos nem recorrências de A", async () => {
      await tx("Netflix", -3990, "2026-08-10");
      await tx("Netflix", -3990, "2026-09-10");
      await tx("Netflix", -3990, "2026-10-10");
      await run();
      await asUser(db, USER_B, async () => {
        expect((await db.query("select 1 from public.notifications")).rows).toHaveLength(0);
        expect((await db.query("select 1 from public.recurring_charges")).rows).toHaveLength(0);
        const updated = await db.query("update public.recurring_charges set dismissed = true");
        expect(updated.affectedRows).toBe(0);
      });
    });

    it("o cliente só marca como lido", async () => {
      await tx("A", -100, "2026-11-04");
      await run();
      await asUser(db, USER_A, async () => {
        await db.query("update public.notifications set read_at = now()");
        await expect(db.query("update public.notifications set title = 'x'")).rejects.toThrow(/permission denied/);
        await expect(
          db.query("insert into public.notifications (user_id, title) values ($1, 'x')", [USER_A]),
        ).rejects.toThrow(/permission denied/);
      });
    });

    it("sem token não executa; funções internas são privadas", async () => {
      await asAnon(db, async () => {
        await expect(db.query("select public.agent_run_automations(null, '2026-01-01')")).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          db.query("select public._agent_notify(gen_random_uuid(), 'k', 't', 'b', 'x')"),
        ).rejects.toThrow(/permission denied/);
      });
    });
  });

  describe("conexões", () => {
    const connect = (item = "item-1") =>
      asUser(db, USER_A, async () => {
        const { rows } = await db.query<{ id: string }>(
          "select public.connect_provider('pluggy', $1, 'Itaú') as id",
          [item],
        );
        return rows[0].id;
      });
    const report = (id: string, status: string, error: string | null = null) =>
      db.query("select public.agent_report_connection($1, $2, $3, null, null, $4)", [TOKEN_A, id, status, error]);
    const state = async (id: string) => {
      const { rows } = await db.query<{ status: string; failure_count: number; retry: boolean; last_error_code: string | null }>(
        `select status, failure_count, next_retry_at is not null as retry, last_error_code
           from public.provider_connections where id = $1`,
        [id],
      );
      return rows[0];
    };

    it("erro espera antes de tentar e sucesso zera a contagem", async () => {
      const id = await connect();
      await report(id, "error", "SITE_NOT_AVAILABLE");
      await report(id, "error", "SITE_NOT_AVAILABLE");
      expect(await state(id)).toEqual({ status: "error", failure_count: 2, retry: true, last_error_code: "SITE_NOT_AVAILABLE" });
      await report(id, "active");
      expect(await state(id)).toEqual({ status: "active", failure_count: 0, retry: false, last_error_code: null });
    });

    it("espera crescente, com teto de 24 horas", async () => {
      const id = await connect();
      for (let i = 0; i < 12; i += 1) await report(id, "error", "X");
      const { rows } = await db.query<{ ok: boolean }>(
        "select next_retry_at <= now() + interval '24 hours 1 minute' as ok from public.provider_connections where id = $1",
        [id],
      );
      expect(rows[0].ok).toBe(true);
    });

    it("reconectar reativa sem duplicar", async () => {
      const id = await connect();
      await asUser(db, USER_A, () => db.query("select public.disconnect_provider($1)", [id]));
      expect((await state(id)).status).toBe("disconnected");
      expect(await connect()).toBe(id);
      expect((await state(id)).status).toBe("active");
    });

    it("desconectar remove os vínculos, mas mantém os lançamentos", async () => {
      const id = await connect();
      await db.query(
        `insert into public.pluggy_links (user_id, pluggy_account_id, pluggy_type, label, account_id, connection_id)
         values ($1, 'p', 'BANK', 'x', $2, $3)`,
        [USER_A, account, id],
      );
      await tx("Mantida", -100, TODAY);
      await asUser(db, USER_A, () => db.query("select public.disconnect_provider($1)", [id]));
      expect((await db.query("select 1 from public.pluggy_links")).rows).toHaveLength(0);
      expect((await db.query("select 1 from public.transactions")).rows).toHaveLength(1);
    });

    it("conexão desconectada ignora relatos atrasados", async () => {
      const id = await connect();
      await asUser(db, USER_A, () => db.query("select public.disconnect_provider($1)", [id]));
      await report(id, "active");
      expect((await state(id)).status).toBe("disconnected");
    });

    it("B não vê, não desconecta e não relata conexão de A", async () => {
      const id = await connect();
      await asUser(db, USER_B, async () => {
        expect((await db.query("select 1 from public.provider_connections")).rows).toHaveLength(0);
        await expect(db.query("select public.disconnect_provider($1)", [id])).rejects.toMatchObject({ code: "P0002" });
      });
      await db.query("select public.agent_report_connection($1, $2, 'error', null, null, 'X')", [TOKEN_B, id]);
      expect((await state(id)).status).toBe("active");
    });

    it("o cliente não grava direto na conexão", async () => {
      await asUser(db, USER_A, async () => {
        await expect(
          db.query("insert into public.provider_connections (user_id, provider, external_item_id) values ($1, 'pluggy', 'x')", [USER_A]),
        ).rejects.toThrow(/permission denied/);
      });
    });
  });

  describe("lote de importação", () => {
    it("não aceita conta nem cartão de outro usuário", async () => {
      const other = await insertAccount(db, USER_B, "De B");
      await asUser(db, USER_A, async () => {
        await expect(
          db.query(
            "insert into public.import_batches (user_id, account_id, source_name, format) values ($1, $2, 'x', 'csv')",
            [USER_A, other],
          ),
        ).rejects.toMatchObject({ code: "23503" });
      });
    });

    it("excluir a conta do lote só limpa o vínculo", async () => {
      const own = await insertAccount(db, USER_A, "Temporária");
      const { rows } = await db.query<{ id: string }>(
        "insert into public.import_batches (user_id, account_id, source_name, format) values ($1, $2, 'x', 'csv') returning id",
        [USER_A, own],
      );
      await db.query("delete from public.bank_accounts where id = $1", [own]);
      const batch = await db.query<{ user_id: string; account_id: string | null }>(
        "select user_id, account_id from public.import_batches where id = $1",
        [rows[0].id],
      );
      expect(batch.rows[0]).toEqual({ user_id: USER_A, account_id: null });
    });
  });
});
