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

const TOKEN_A = "wos_token_a_para_testes";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

const MIGRATIONS = [
  "0002_accounts.sql",
  "0003_categories.sql",
  "0004_transaction_types.sql",
  "0005_transactions.sql",
  "0006_cards.sql",
  "0007_capture.sql",
  "0008_agent_core.sql",
];

type Ingest = {
  source?: string;
  ref?: string | null;
  description?: string;
  amount: number;
  date?: string;
  method?: string | null;
  hint?: string | null;
  account?: string | null;
  card?: string | null;
  reason?: string | null;
  intent?: string;
};

describe("migration 0008 sobre dados existentes", () => {
  it("corrige capturas marcadas como manuais e adiciona categorias sem apagar nada", async () => {
    const db = await createDatabase();
    for (const file of MIGRATIONS.slice(0, 6)) await applyMigration(db, file);
    await createUser(db, USER_A, "a@teste.dev");
    const account = await insertAccount(db, USER_A, "Conta");
    const { rows: cat } = await db.query<{ id: string }>(
      "select id from public.transaction_categories where user_id = $1 and slug = 'lazer'",
      [USER_A],
    );
    await db.query(
      `insert into public.transactions (user_id, account_id, category_id, category_source, posted_at, description, amount_cents, kind, notes, dedupe_hash)
       values ($1, $2, $3, 'manual', '2026-11-01', 'Capturada', -100, 'expense', 'Captura automática', 'x'),
              ($1, $2, $3, 'manual', '2026-11-01', 'Minha', -100, 'expense', null, 'y')`,
      [USER_A, account, cat[0].id],
    );

    await applyMigration(db, "0008_agent_core.sql");

    const { rows } = await db.query<{ description: string; category_source: string }>(
      "select description, category_source from public.transactions order by description",
    );
    expect(rows).toEqual([
      { description: "Capturada", category_source: "rule" },
      { description: "Minha", category_source: "manual" },
    ]);
    const slugs = await db.query<{ slug: string }>(
      "select slug from public.transaction_categories where user_id = $1",
      [USER_A],
    );
    const names = slugs.rows.map((r) => r.slug);
    expect(names).toEqual(expect.arrayContaining(["lazer", "restaurantes", "combustivel", "tarifas"]));
    expect(await balanceOf(db, account)).toBe(-200);
  });
});

describe("núcleo do agente", () => {
  let db: PGlite;
  let account: string;
  let reserve: string;
  let card: string;

  const ingest = async (i: Ingest) => {
    const { rows } = await db.query<{ r: { status: string; transaction_id?: string; reason?: string } }>(
      `select public.ingest_capture($1,$2,$3,$4,$5,$6,$7,$8,null,$9,$10,null,$11,$12) as r`,
      [
        TOKEN_A,
        i.source ?? "pluggy",
        i.ref ?? null,
        i.description ?? "Loja Teste",
        i.amount,
        i.date ?? "2026-11-05",
        i.method ?? null,
        i.hint ?? null,
        i.account ?? null,
        i.card ?? null,
        i.reason ?? null,
        i.intent ?? "normal",
      ],
    );
    return rows[0].r;
  };

  const categorySlug = async (transactionId?: string) => {
    const { rows } = await db.query<{ slug: string | null; source: string | null }>(
      `select c.slug, t.category_source as source from public.transactions t
       left join public.transaction_categories c on c.id = t.category_id where t.id = $1`,
      [transactionId],
    );
    return rows[0];
  };

  const categoryId = async (slug: string) => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.transaction_categories where user_id = $1 and slug = $2",
      [USER_A, slug],
    );
    return rows[0].id;
  };

  const lastPending = async () => {
    const { rows } = await db.query<{ id: string; reason: string; candidate_transaction_id: string | null }>(
      "select id, reason, candidate_transaction_id from public.capture_events where status = 'pending' order by created_at desc limit 1",
    );
    return rows[0];
  };

  beforeAll(async () => {
    db = await createDatabase();
    for (const file of MIGRATIONS) await applyMigration(db, file);
    await createUser(db, USER_A, "a@teste.dev");
    await createUser(db, USER_B, "b@teste.dev");
    await db.query(
      "insert into public.capture_tokens (user_id, name, token_hash) values ($1, 'iPhone', $2)",
      [USER_A, sha(TOKEN_A)],
    );
  });

  beforeEach(async () => {
    await db.exec(`
      delete from public.capture_events;
      delete from public.transactions where kind = 'refund';
      delete from public.category_rules;
      delete from public.agent_settings;
      delete from public.agent_runs;
      delete from public.transactions;
      delete from public.card_installments;
      delete from public.card_invoices;
      delete from public.credit_cards;
      delete from public.bank_accounts;
      update public.capture_tokens set window_count = 0, window_started_at = null;
    `);
    account = await insertAccount(db, USER_A, "Conta Itaú", 100000);
    reserve = await insertAccount(db, USER_A, "Reserva", 50000);
    const { rows } = await db.query<{ id: string }>(
      `insert into public.credit_cards (user_id, institution, name, limit_cents, closing_day, due_day)
       values ($1, 'Nubank', 'Roxinho', 500000, 28, 5) returning id`,
      [USER_A],
    );
    card = rows[0].id;
  });

  describe("normalização", () => {
    it.each([
      ["PIX ENVIADO  João Ávila", "joao avila"],
      ["COMPRA CARTAO PADARIA CENTRAL LTDA", "padaria central"],
      ["Netflix.com", "netflix"],
      ["", ""],
    ])("%j vira %j", async (input, expected) => {
      const { rows } = await db.query<{ n: string }>("select public.agent_normalize($1) as n", [input]);
      expect(rows[0].n).toBe(expected);
    });

    it("mede a semelhança por palavras", async () => {
      const sim = async (a: string, b: string) => {
        const { rows } = await db.query<{ s: string }>("select public.agent_similarity($1, $2) as s", [a, b]);
        return Number(rows[0].s);
      };
      expect(await sim("PADARIA CENTRAL", "Padaria Central LTDA")).toBe(1);
      expect(await sim("PAG*PADARIA CENTRAL SP", "Padaria Central")).toBe(1);
      expect(await sim("Padaria Central", "Posto Shell")).toBe(0);
    });
  });

  describe("classificação", () => {
    it("usa o dicionário em português", async () => {
      const r = await ingest({ amount: -5000, account, description: "UBER *TRIP 1234", ref: "a" });
      expect(await categorySlug(r.transaction_id)).toEqual({ slug: "transporte", source: "rule" });
    });

    it("a palavra mais longa vence", async () => {
      const r = await ingest({ amount: -5000, card, description: "Mercado Livre", ref: "b" });
      expect((await categorySlug(r.transaction_id)).slug).toBe("compras");
    });

    it("não casa pedaço de palavra", async () => {
      const r = await ingest({ amount: -5000, account, description: "Timbó Materiais", ref: "c" });
      expect((await categorySlug(r.transaction_id)).slug).toBeNull();
    });

    it("sem correspondência fica sem categoria", async () => {
      const r = await ingest({ amount: -5000, account, description: "Xyz Qwerty", ref: "d" });
      expect((await categorySlug(r.transaction_id)).slug).toBeNull();
    });

    it("receita usa categoria de receita", async () => {
      const r = await ingest({ amount: 500000, account, description: "SALARIO EMPRESA X", ref: "e" });
      expect((await categorySlug(r.transaction_id)).slug).toBe("salario");
    });

    it("confiança abaixo do limite vira só sugestão", async () => {
      await db.query(
        "insert into public.agent_settings (user_id, min_confidence) values ($1, 95)",
        [USER_A],
      );
      const r = await ingest({ amount: -5000, account, description: "Padaria Central", ref: "f" });
      expect((await categorySlug(r.transaction_id)).slug).toBeNull();
      const { rows } = await db.query<{ suggested_category_id: string; confidence: number }>(
        "select suggested_category_id, confidence from public.capture_events where external_ref = 'f'",
      );
      expect(rows[0].suggested_category_id).toBe(await categoryId("alimentacao"));
      expect(rows[0].confidence).toBe(85);
    });

    it("categorização automática pode ser desligada", async () => {
      await db.query(
        "insert into public.agent_settings (user_id, auto_categorize) values ($1, false)",
        [USER_A],
      );
      const r = await ingest({ amount: -5000, account, description: "Netflix", ref: "g" });
      expect((await categorySlug(r.transaction_id)).slug).toBeNull();
    });

    it("compra capturada no cartão não é marcada como manual", async () => {
      const r = await ingest({ amount: -3000, card, description: "Netflix", ref: "h" });
      expect(await categorySlug(r.transaction_id)).toEqual({ slug: "assinaturas", source: "rule" });
    });
  });

  describe("aprendizado", () => {
    it("sua correção vira regra e vale para o próximo, acima do dicionário", async () => {
      const first = await ingest({ amount: -3000, account, description: "Padaria do Zé", ref: "l1" });
      const lazer = await categoryId("lazer");
      await asUser(db, USER_A, () =>
        db.query(
          "update public.transactions set category_id = $1, category_source = 'manual' where id = $2",
          [lazer, first.transaction_id],
        ),
      );

      const { rows } = await db.query<{ pattern: string; category_id: string }>(
        "select pattern, category_id from public.category_rules",
      );
      expect(rows).toEqual([{ pattern: "padaria ze", category_id: lazer }]);

      const next = await ingest({ amount: -999, account, description: "PADARIA DO ZE", ref: "l2" });
      expect((await categorySlug(next.transaction_id)).slug).toBe("lazer");
    });

    it("corrigir de novo atualiza a regra, sem duplicar", async () => {
      const first = await ingest({ amount: -3000, account, description: "Loja Boa", ref: "l3" });
      for (const slug of ["lazer", "compras"]) {
        const id = await categoryId(slug);
        await db.query(
          "update public.transactions set category_id = $1, category_source = 'manual' where id = $2",
          [id, first.transaction_id],
        );
      }
      const { rows } = await db.query<{ category_id: string }>("select category_id from public.category_rules");
      expect(rows).toEqual([{ category_id: await categoryId("compras") }]);
    });

    it("categoria automática não gera regra", async () => {
      await ingest({ amount: -5000, account, description: "Netflix", ref: "l4" });
      const { rows } = await db.query("select 1 from public.category_rules");
      expect(rows).toHaveLength(0);
    });

    it("o agente nunca sobrescreve um lançamento confirmado", async () => {
      const lazer = await categoryId("lazer");
      await db.query(
        `insert into public.transactions (user_id, account_id, category_id, category_source, posted_at, description, amount_cents, kind, dedupe_hash)
         values ($1, $2, $3, 'manual', '2026-11-05', 'Netflix', -3000, 'expense', 'manual:1')`,
        [USER_A, account, lazer],
      );
      const result = await ingest({ amount: -3000, account, description: "NETFLIX.COM", ref: "m1" });
      expect(result.status).toBe("matched");
      expect(await categorySlug(result.transaction_id)).toEqual({ slug: "lazer", source: "manual" });
    });
  });

  describe("deduplicação", () => {
    it("mesmo valor e data, com nome parecido: concilia", async () => {
      await ingest({ source: "apple_pay", amount: -2500, card, description: "PADARIA CENTRAL" });
      const second = await ingest({ amount: -2500, card, description: "PAG*Padaria Central SP", ref: "d1", date: "2026-11-06" });
      expect(second.status).toBe("matched");
    });

    it("mesmo valor e data, com nome diferente: pede revisão em vez de assumir", async () => {
      const first = await ingest({ source: "apple_pay", amount: -2500, card, description: "Padaria Central" });
      const second = await ingest({ amount: -2500, card, description: "Posto Shell", ref: "d2" });
      expect(second.status).toBe("pending");
      const pending = await lastPending();
      expect(pending.reason).toContain("Possível duplicidade");
      expect(pending.candidate_transaction_id).toBe(first.transaction_id);
    });

    it("descrição genérica não impede a conciliação", async () => {
      await ingest({ source: "apple_pay", amount: -700, account, description: "Padaria" });
      expect((await ingest({ source: "notification", amount: -700, account, description: "Compra capturada" })).status).toBe("matched");
    });

    it("confirmar que é o mesmo lançamento não grava de novo", async () => {
      await ingest({ source: "apple_pay", amount: -2500, card, description: "Padaria Central" });
      await ingest({ amount: -2500, card, description: "Posto Shell", ref: "d3" });
      const pending = await lastPending();
      await asUser(db, USER_A, () => db.query("select public.confirm_capture_match($1)", [pending.id]));
      const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.transactions");
      expect(rows[0].n).toBe(1);
    });

    it("são lançamentos diferentes: registrar mesmo assim", async () => {
      await ingest({ source: "apple_pay", amount: -2500, card, description: "Padaria Central" });
      await ingest({ amount: -2500, card, description: "Posto Shell", ref: "d4" });
      const pending = await lastPending();
      await asUser(db, USER_A, () => db.query("select public.resolve_capture($1, null, $2)", [pending.id, card]));
      const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.transactions");
      expect(rows[0].n).toBe(2);
    });

    it("reenviar o mesmo identificador fica registrado na atividade", async () => {
      await ingest({ amount: -100, account, ref: "d5" });
      expect((await ingest({ amount: -100, account, ref: "d5" })).status).toBe("duplicate");
      const { rows } = await db.query<{ n: number }>(
        "select count(*)::int as n from public.audit_logs where event = 'agent.duplicate_blocked' and entity_id = 'd5'",
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe("pagamento de fatura no extrato", () => {
    const purchase = (amount: number, targetCard = card) =>
      asUser(db, USER_A, () =>
        db.query(
          "select public.create_card_purchase($1, 'Compra', $2, 1, '2026-11-05', null, null, gen_random_uuid())",
          [targetCard, amount],
        ),
      );

    it("valor igual a uma única fatura: concilia, debita e não vira despesa", async () => {
      await purchase(30000);
      const r = await ingest({ amount: -30000, account, description: "PAG FATURA NUBANK", ref: "i1", intent: "invoice_payment" });
      expect(r.status).toBe("created");
      expect(await balanceOf(db, account)).toBe(70000);
      const { rows } = await db.query<{ kind: string }>("select kind from public.transactions where id = $1", [r.transaction_id]);
      expect(rows[0].kind).toBe("invoice_payment");
      const invoice = await db.query<{ status: string }>("select status from public.card_invoices");
      expect(invoice.rows[0].status).toBe("paid");
    });

    it("sem correspondência exata: pede a fatura e não entra nos saldos", async () => {
      await purchase(30000);
      const r = await ingest({ amount: -29999, account, description: "PAG FATURA", ref: "i2", intent: "invoice_payment" });
      expect(r.status).toBe("pending");
      expect(await balanceOf(db, account)).toBe(100000);
    });

    it("duas faturas com o mesmo valor: pergunta em vez de escolher", async () => {
      await purchase(30000);
      const { rows } = await db.query<{ id: string }>(
        `insert into public.credit_cards (user_id, institution, name, limit_cents, closing_day, due_day)
         values ($1, 'Itaú', 'Outro', 100000, 28, 5) returning id`,
        [USER_A],
      );
      await purchase(30000, rows[0].id);
      const r = await ingest({ amount: -30000, account, description: "PAG FATURA", ref: "i3", intent: "invoice_payment" });
      expect(r.status).toBe("pending");
    });

    it("escolher a fatura registra o pagamento", async () => {
      await purchase(30000);
      await ingest({ amount: -10000, account, description: "PAG FATURA", ref: "i4", intent: "invoice_payment" });
      const pending = await lastPending();
      const { rows: inv } = await db.query<{ id: string }>("select id from public.card_invoices");
      await asUser(db, USER_A, () =>
        db.query("select public.resolve_capture_invoice($1, $2)", [pending.id, inv[0].id]),
      );
      expect(await balanceOf(db, account)).toBe(90000);
    });

    it("pagamento já registrado à mão é reconhecido", async () => {
      await purchase(30000);
      const { rows: inv } = await db.query<{ id: string }>("select id from public.card_invoices");
      await asUser(db, USER_A, () =>
        db.query("select public.pay_invoice($1, $2, 30000, '2026-11-05', gen_random_uuid())", [inv[0].id, account]),
      );
      const r = await ingest({ amount: -30000, account, description: "PAG FATURA", ref: "i5", intent: "invoice_payment" });
      expect(r.status).toBe("matched");
      expect(await balanceOf(db, account)).toBe(70000);
    });

    it("pagamento de fatura não pode ser resolvido como despesa comum", async () => {
      await ingest({ amount: -10000, account, description: "PAG FATURA", ref: "i6", intent: "invoice_payment" });
      const pending = await lastPending();
      await expect(
        asUser(db, USER_A, () => db.query("select public.resolve_capture($1, $2, null)", [pending.id, account])),
      ).rejects.toMatchObject({ code: "WL013" });
    });
  });

  describe("estornos", () => {
    it("no cartão reduz a fatura do mês", async () => {
      await asUser(db, USER_A, () =>
        db.query("select public.create_card_purchase($1, 'Compra', 10000, 1, '2026-11-05', null, null, gen_random_uuid())", [card]),
      );
      const r = await ingest({ amount: 2500, card, description: "ESTORNO LOJA", ref: "e1", intent: "refund" });
      expect(r.status).toBe("created");
      const { rows } = await db.query<{ total_cents: number }>("select total_cents from public.card_invoices");
      expect(Number(rows[0].total_cents)).toBe(7500);
      const tx = await db.query<{ kind: string }>("select kind from public.transactions where id = $1", [r.transaction_id]);
      expect(tx.rows[0].kind).toBe("refund");
    });

    it("maior que a fatura do mês pede revisão", async () => {
      const r = await ingest({ amount: 2500, card, description: "ESTORNO", ref: "e2", intent: "refund" });
      expect(r).toMatchObject({ status: "pending", reason: "Estorno maior que a fatura do mês" });
    });

    it("na conta entra como estorno, não como receita", async () => {
      const r = await ingest({ amount: 4000, account, description: "DEVOLUCAO PIX", ref: "e3", intent: "refund", method: "pix" });
      expect(await balanceOf(db, account)).toBe(104000);
      const { rows } = await db.query<{ kind: string }>("select kind from public.transactions where id = $1", [r.transaction_id]);
      expect(rows[0].kind).toBe("refund");
    });
  });

  describe("transferência entre contas próprias", () => {
    it("o segundo lado vira sugestão e não entra nos saldos", async () => {
      const first = await ingest({ amount: -20000, account, description: "PIX ENVIADO", method: "pix", ref: "t1" });
      const second = await ingest({ amount: 20000, account: reserve, description: "PIX RECEBIDO", method: "pix", ref: "t2" });
      expect(first.status).toBe("created");
      expect(second.status).toBe("pending");
      expect(await balanceOf(db, reserve)).toBe(50000);
    });

    it("confirmar converte o par e preserva o patrimônio, sem receita nem despesa", async () => {
      await ingest({ amount: -20000, account, description: "PIX ENVIADO", method: "pix", ref: "t3" });
      await ingest({ amount: 20000, account: reserve, description: "PIX RECEBIDO", method: "pix", ref: "t4", date: "2026-11-06" });
      const pending = await lastPending();
      await asUser(db, USER_A, () => db.query("select public.link_own_transfer($1)", [pending.id]));

      expect(await balanceOf(db, account)).toBe(80000);
      expect(await balanceOf(db, reserve)).toBe(70000);
      const { rows } = await db.query<{ kind: string; n: number }>(
        "select kind, count(*)::int as n from public.transactions group by kind",
      );
      expect(rows).toEqual([{ kind: "transfer", n: 2 }]);
    });

    it("negar registra como receita normal", async () => {
      await ingest({ amount: -20000, account, description: "PIX ENVIADO", method: "pix", ref: "t5" });
      await ingest({ amount: 20000, account: reserve, description: "PIX RECEBIDO", method: "pix", ref: "t6" });
      const pending = await lastPending();
      await asUser(db, USER_A, () => db.query("select public.resolve_capture($1, $2, null)", [pending.id, reserve]));
      expect(await balanceOf(db, reserve)).toBe(70000);
    });

    it("sem lado oposto, Pix de terceiros entra normalmente", async () => {
      expect((await ingest({ amount: 9000, account, description: "João", method: "pix", ref: "t7" })).status).toBe("created");
    });

    it("o outro lado precisa estar em outra conta sua", async () => {
      await ingest({ amount: -20000, account, description: "João", method: "pix", ref: "t8" });
      expect((await ingest({ amount: 20000, account, description: "Maria", method: "pix", ref: "t9" })).status).toBe("created");
    });
  });

  describe("pausa e controle", () => {
    it("pausado: nada se perde e nada entra nos saldos", async () => {
      await db.query("insert into public.agent_settings (user_id, paused) values ($1, true)", [USER_A]);
      const r = await ingest({ amount: -100, account, ref: "p1" });
      expect(r.status).toBe("pending");
      expect(await balanceOf(db, account)).toBe(100000);
    });

    it("registro automático desligado manda tudo para revisão", async () => {
      await db.query("insert into public.agent_settings (user_id, auto_register) values ($1, false)", [USER_A]);
      expect((await ingest({ amount: -100, account, ref: "p2" })).status).toBe("pending");
    });
  });

  describe("limite de taxa", () => {
    it("bloqueia o endpoint público acima de 60 por minuto, mas não a Pluggy", async () => {
      await db.query("update public.capture_tokens set window_started_at = now(), window_count = 60");
      await expect(
        ingest({ source: "apple_pay", amount: -1, hint: "Roxinho", description: "A" }),
      ).rejects.toMatchObject({ code: "WL014" });
      expect((await ingest({ source: "pluggy", ref: "r1", amount: -1, account, description: "B" })).status).toBe("created");
    });

    it("a janela reinicia depois de um minuto", async () => {
      await db.query("update public.capture_tokens set window_started_at = now() - interval '2 minutes', window_count = 999");
      expect((await ingest({ source: "apple_pay", amount: -1, hint: "Roxinho", description: "A" })).status).toBe("created");
    });
  });

  describe("histórico", () => {
    it("guarda o valor anterior em edição e exclusão", async () => {
      const r = await ingest({ amount: -100, account, ref: "h1", description: "Antes" });
      await db.query("update public.transactions set description = 'Depois' where id = $1", [r.transaction_id]);
      await db.query("delete from public.transactions where id = $1", [r.transaction_id]);
      const { rows } = await db.query<{ operation: string; previous: { description: string } }>(
        "select operation, previous from public.transaction_revisions where transaction_id = $1 order by id",
        [r.transaction_id],
      );
      expect(rows.map((x) => [x.operation, x.previous.description])).toEqual([
        ["update", "Antes"],
        ["delete", "Depois"],
      ]);
    });

    it("não gera revisão sem mudança relevante", async () => {
      const r = await ingest({ amount: -100, account, ref: "h2" });
      await db.query("update public.transactions set competence_date = '2026-01-01' where id = $1", [r.transaction_id]);
      const { rows } = await db.query("select 1 from public.transaction_revisions where transaction_id = $1", [r.transaction_id]);
      expect(rows).toHaveLength(0);
    });

    it("cada decisão fica na linha do tempo", async () => {
      await ingest({ amount: -100, card, ref: "h3", description: "Loja" });
      const { rows } = await db.query<{ event: string }>(
        "select event from public.audit_logs where event like 'agent.%' order by id desc limit 1",
      );
      expect(rows[0].event).toBe("agent.card_purchase_registered");
    });
  });

  describe("execuções", () => {
    const start = async () => {
      const { rows } = await db.query<{ id: string | null }>(
        "select public.agent_start_run($1, 'sync') as id",
        [TOKEN_A],
      );
      return rows[0].id;
    };

    it("só uma por vez, e libera ao terminar", async () => {
      const first = await start();
      expect(first).toBeTruthy();
      expect(await start()).toBeNull();
      await db.query("select public.agent_finish_run($1, $2, 'success', '{}', null)", [TOKEN_A, first]);
      expect(await start()).toBeTruthy();
    });

    it("recupera uma execução interrompida", async () => {
      const first = await start();
      await db.query("update public.agent_runs set started_at = now() - interval '20 minutes' where id = $1", [first]);
      expect(await start()).toBeTruthy();
      const { rows } = await db.query<{ status: string; error_code: string }>(
        "select status, error_code from public.agent_runs where id = $1",
        [first],
      );
      expect(rows[0]).toEqual({ status: "failed", error_code: "interrupted" });
    });
  });

  describe("isolamento", () => {
    it("B não vê configurações, execuções, revisões nem regras de A", async () => {
      await db.query("insert into public.agent_settings (user_id, paused) values ($1, true)", [USER_A]);
      await db.query("select public.agent_start_run($1, 'sync')", [TOKEN_A]);
      const r = await ingest({ amount: -100, account, ref: "x1", reason: null });
      await db.query("update public.transactions set description = 'Y' where id = $1", [r.transaction_id ?? null]);
      await asUser(db, USER_B, async () => {
        for (const table of ["agent_settings", "agent_runs", "transaction_revisions", "category_rules"]) {
          const { rows } = await db.query(`select 1 from public.${table}`);
          expect(rows).toHaveLength(0);
        }
      });
    });

    it("B não confirma, liga nem resolve eventos de A", async () => {
      await ingest({ amount: -20000, account, description: "PIX", method: "pix", ref: "x2" });
      await ingest({ amount: 20000, account: reserve, description: "PIX", method: "pix", ref: "x3" });
      const pending = await lastPending();
      for (const fn of ["confirm_capture_match", "link_own_transfer"]) {
        await expect(
          asUser(db, USER_B, () => db.query(`select public.${fn}($1)`, [pending.id])),
        ).rejects.toMatchObject({ code: "P0002" });
      }
      await expect(
        asUser(db, USER_B, () => db.query("select public.resolve_capture_invoice($1, gen_random_uuid())", [pending.id])),
      ).rejects.toMatchObject({ code: "P0002" });
    });

    it("anon não chama funções de revisão nem internas; dicionário é privado", async () => {
      await asAnon(db, async () => {
        await expect(db.query("select public.link_own_transfer(gen_random_uuid())")).rejects.toThrow(/permission denied/);
        await expect(db.query("select * from public.agent_keywords")).rejects.toThrow(/permission denied/);
        await expect(db.query("select public._agent_log(gen_random_uuid(), 'x', 'y', 'z')")).rejects.toThrow(/permission denied/);
      });
      await asUser(db, USER_A, async () => {
        await expect(db.query("select public._capture_card_refund(gen_random_uuid(), gen_random_uuid(), 'x', 1, '2026-01-01', null)")).rejects.toThrow(/permission denied/);
        await expect(db.query("insert into public.agent_runs (user_id, kind) values ($1, 'sync')", [USER_A])).rejects.toThrow(/permission denied/);
      });
    });
  });

  it("não impede excluir um usuário com histórico do agente", async () => {
    const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await createUser(db, userId, "c@teste.dev");
    const own = await insertAccount(db, userId, "Conta");
    const { rows } = await db.query<{ id: string }>(
      `insert into public.transactions (user_id, account_id, posted_at, description, amount_cents, kind, dedupe_hash)
       values ($1, $2, '2026-11-01', 'A', -1, 'expense', 'c') returning id`,
      [userId, own],
    );
    await db.query("update public.transactions set description = 'B' where id = $1", [rows[0].id]);
    await db.query("insert into public.agent_settings (user_id) values ($1)", [userId]);
    await db.query("delete from auth.users where id = $1", [userId]);
    const left = await db.query("select 1 from public.transaction_revisions where user_id = $1", [userId]);
    expect(left.rows).toHaveLength(0);
  });
});
