import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenFinanceProvider, ProviderEvent } from "@/features/agent/providers/types";
import { syncAgent } from "@/features/agent/sync";
import { todayInSaoPaulo } from "@/lib/dates";
import { USER_A, USER_B, applyMigration, asAnon, asUser, balanceOf, createDatabase, createUser, insertAccount } from "./harness";

const TOKEN_A = "wos_token_a_sincronizacao";
const TOKEN_B = "wos_token_b_sincronizacao";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** Fala com o banco como o supabase-js falaria: pela RPC, com o papel certo e sem privilégios. */
function rpcClient(db: PGlite, run: <T>(fn: () => Promise<T>) => Promise<T>) {
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const params = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
      try {
        const { rows } = await run(() =>
          db.query<Record<string, unknown>>(`select * from public.${fn}(${params})`, keys.map((k) => args[k])),
        );
        const first = rows[0];
        const scalar = first && Object.keys(first).length === 1 && fn in first;
        return { data: scalar ? first[fn] : rows, error: null };
      } catch (error) {
        return { data: null, error: { code: (error as { code?: string }).code } };
      }
    },
  };
}

const event = (ref: string, description: string, amountCents: number, date: string): ProviderEvent => ({
  externalRef: ref,
  description,
  amountCents,
  date,
  method: "debit",
  intent: "normal",
  reason: null,
});

function fakeProvider(overrides: Partial<OpenFinanceProvider> = {}): OpenFinanceProvider {
  return {
    id: "pluggy",
    listAccounts: async () => [],
    listEvents: vi.fn(async () => ({ events: [], ignored: 0 })),
    getConnectionHealth: vi.fn(async () => ({
      status: "active" as const,
      institution: "Banco",
      consentExpiresAt: null,
      errorCode: null,
    })),
    ...overrides,
  };
}

describe("sincronização do agente", () => {
  let db: PGlite;
  let account: string;
  let client: ReturnType<typeof rpcClient>;
  let counter = 0;
  const today = todayInSaoPaulo();

  const addConnection = async (user: string, item: string, pluggyAccount: string, accountId: string) => {
    const { rows } = await asUser(db, user, () =>
      db.query<{ id: string }>(
        "select public.connect_provider('pluggy', $1, null) as id",
        [item],
      ),
    );
    const id = rows[0].id;
    await db.query(
      `insert into public.pluggy_links (user_id, pluggy_account_id, pluggy_type, label, account_id, connection_id)
       values ($1, $2, 'BANK', 'Conta', $3, $4)`,
      [user, pluggyAccount, accountId, id],
    );
    return id;
  };

  const lastRun = async () =>
    (await db.query<{ status: string; error_code: string | null }>(
      "select status, error_code from public.agent_runs where user_id = $1 order by started_at desc limit 1",
      [USER_A],
    )).rows[0];

  const connection = async (id: string) =>
    (await db.query<{ status: string; last_error_code: string | null; failure_count: number; next_retry_at: string | null; last_sync_at: string | null }>(
      "select status, last_error_code, failure_count, next_retry_at, last_sync_at from public.provider_connections where id = $1",
      [id],
    )).rows[0];

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
    for (const [user, token] of [[USER_A, TOKEN_A], [USER_B, TOKEN_B]]) {
      await db.query("insert into public.capture_tokens (user_id, name, token_hash) values ($1, 'cron', $2)", [user, sha(token)]);
    }
    client = rpcClient(db, (fn) => asAnon(db, fn));
  });

  beforeEach(async () => {
    counter += 1;
    await db.exec(`
      delete from public.capture_events;
      delete from public.agent_runs;
      delete from public.pluggy_links;
      delete from public.provider_connections;
      delete from public.notifications;
      delete from public.agent_settings;
      delete from public.transactions;
    `);
    account = await insertAccount(db, USER_A, `Principal ${counter}`, 100000);
  });

  it("registra os eventos, marca como sincronizada e encerra a execução", async () => {
    const id = await addConnection(USER_A, "item-a-1", "pl-1", account);
    const provider = fakeProvider({
      listEvents: async () => ({ events: [event("r1", "MERCADO CENTRAL", -2500, today)], ignored: 1 }),
    });

    const summary = await syncAgent(client, provider, TOKEN_A);

    expect(summary).toMatchObject({ created: 1, ignored: 1, failed: 0, connectionsFailed: 0 });
    expect(await balanceOf(db, account)).toBe(97500);
    expect((await lastRun()).status).toBe("success");
    expect((await connection(id)).status).toBe("active");
    const { rows } = await db.query<{ last_synced_at: string | null }>("select last_synced_at from public.pluggy_links");
    expect(rows[0].last_synced_at).not.toBeNull();
  });

  it("sincronizar de novo não duplica lançamentos nem altera o saldo", async () => {
    await addConnection(USER_A, "item-a-1", "pl-1", account);
    const provider = fakeProvider({
      listEvents: async () => ({ events: [event("r1", "MERCADO CENTRAL", -2500, today)], ignored: 0 }),
    });

    await syncAgent(client, provider, TOKEN_A);
    const second = await syncAgent(client, provider, TOKEN_A);

    expect(second).toMatchObject({ created: 0, duplicate: 1 });
    expect(await balanceOf(db, account)).toBe(97500);
  });

  it("uma conexão com falha não interrompe as outras nem perde a janela de sincronização", async () => {
    const other = await insertAccount(db, USER_A, `Outra ${counter}`, 0);
    const bad = await addConnection(USER_A, "item-ruim", "pl-ruim", account);
    const good = await addConnection(USER_A, "item-bom", "pl-bom", other);
    const provider = fakeProvider({
      listEvents: async (acc) => {
        if (acc.id === "pl-ruim") throw new Error("HTTP 500");
        return { events: [event("r2", "PADARIA", -1000, today)], ignored: 0 };
      },
    });

    const summary = await syncAgent(client, provider, TOKEN_A);

    expect(summary).toMatchObject({ created: 1, connectionsFailed: 1 });
    expect(await balanceOf(db, other)).toBe(-1000);
    expect(await balanceOf(db, account)).toBe(100000);
    expect((await connection(bad))).toMatchObject({ status: "error", last_error_code: "PROVIDER_UNAVAILABLE", failure_count: 1 });
    expect((await connection(good)).status).toBe("active");
    expect((await lastRun()).status).toBe("partial");

    const { rows } = await db.query<{ pluggy_account_id: string; last_synced_at: string | null }>(
      "select pluggy_account_id, last_synced_at from public.pluggy_links order by pluggy_account_id",
    );
    expect(rows.find((r) => r.pluggy_account_id === "pl-ruim")?.last_synced_at).toBeNull();
    expect(rows.find((r) => r.pluggy_account_id === "pl-bom")?.last_synced_at).not.toBeNull();
  });

  it("espera antes de tentar de novo uma conexão com falha", async () => {
    const bad = await addConnection(USER_A, "item-ruim", "pl-ruim", account);
    const listEvents = vi.fn(async () => {
      throw new Error("HTTP 500");
    });
    const provider = fakeProvider({ listEvents });

    await syncAgent(client, provider, TOKEN_A);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect((await connection(bad)).next_retry_at).not.toBeNull();

    await syncAgent(client, provider, TOKEN_A);
    expect(listEvents).toHaveBeenCalledTimes(1);

    const later = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    await syncAgent(client, provider, TOKEN_A, later);
    expect(listEvents).toHaveBeenCalledTimes(2);
  });

  it("autorização vencida não lê nada: vazio não pode parecer ausência de movimentos", async () => {
    const id = await addConnection(USER_A, "item-vencido", "pl-1", account);
    const listEvents = vi.fn(async () => ({ events: [], ignored: 0 }));
    const provider = fakeProvider({
      listEvents,
      getConnectionHealth: async () => ({
        status: "expired",
        institution: "Banco",
        consentExpiresAt: null,
        errorCode: "USER_AUTHORIZATION_EXPIRED",
      }),
    });

    const summary = await syncAgent(client, provider, TOKEN_A);

    expect(listEvents).not.toHaveBeenCalled();
    expect(summary.connectionsFailed).toBe(1);
    expect(await connection(id)).toMatchObject({ status: "expired", last_error_code: "USER_AUTHORIZATION_EXPIRED" });
    const { rows } = await db.query("select last_synced_at from public.pluggy_links where last_synced_at is not null");
    expect(rows).toHaveLength(0);
  });

  it("falha ao registrar um evento mantém a conta para nova tentativa", async () => {
    const id = await addConnection(USER_A, "item-a-1", "pl-1", account);
    const provider = fakeProvider({
      // Valor zero é recusado pelo banco.
      listEvents: async () => ({ events: [event("r3", "INVALIDO", 0, today)], ignored: 0 }),
    });

    const summary = await syncAgent(client, provider, TOKEN_A);

    expect(summary.failed).toBe(1);
    expect((await connection(id))).toMatchObject({ status: "error", last_error_code: "PROCESSING_FAILED" });
    const { rows } = await db.query<{ last_synced_at: string | null }>("select last_synced_at from public.pluggy_links");
    expect(rows[0].last_synced_at).toBeNull();
  });

  it("pausado não fala com o provedor", async () => {
    await addConnection(USER_A, "item-a-1", "pl-1", account);
    await db.query("insert into public.agent_settings (user_id, paused) values ($1, true)", [USER_A]);
    const provider = fakeProvider();

    const summary = await syncAgent(client, provider, TOKEN_A);

    expect(summary.skipped).toBe("paused");
    expect(provider.getConnectionHealth).not.toHaveBeenCalled();
  });

  it("duas execuções não correm ao mesmo tempo", async () => {
    await addConnection(USER_A, "item-a-1", "pl-1", account);
    await db.query("insert into public.agent_runs (user_id, kind, status) values ($1, 'sync', 'running')", [USER_A]);
    const provider = fakeProvider();

    const summary = await syncAgent(client, provider, TOKEN_A);

    expect(summary.skipped).toBe("already_running");
    expect(provider.getConnectionHealth).not.toHaveBeenCalled();
  });

  it("token inválido não executa nada", async () => {
    const provider = fakeProvider();
    await expect(syncAgent(client, provider, "wos_token_inexistente")).rejects.toThrow();
    expect(provider.getConnectionHealth).not.toHaveBeenCalled();
  });

  it("o token de um usuário nunca alcança as conexões de outro", async () => {
    const accountB = await insertAccount(db, USER_B, `Conta B ${counter}`, 0);
    await addConnection(USER_B, "item-b-1", "pl-b", accountB);
    const provider = fakeProvider();

    await syncAgent(client, provider, TOKEN_A);

    expect(provider.getConnectionHealth).not.toHaveBeenCalled();
    expect(provider.listEvents).not.toHaveBeenCalled();
  });

  it("também roda com a sessão do usuário, sem token", async () => {
    await addConnection(USER_A, "item-a-1", "pl-1", account);
    const session = rpcClient(db, (fn) => asUser(db, USER_A, fn));
    const provider = fakeProvider({
      listEvents: async () => ({ events: [event("r9", "FARMACIA", -700, today)], ignored: 0 }),
    });

    expect(await syncAgent(session, provider, null)).toMatchObject({ created: 1 });
  });
});

describe("gravações feitas pela sessão do usuário", () => {
  let db: PGlite;
  let account: string;

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
    account = await insertAccount(db, USER_A, "Principal", 0);
  });

  it("importação: lote, lançamento ligado ao lote e categoria escolhida vira manual", async () => {
    const category = (await db.query<{ id: string }>(
      "select id from public.transaction_categories where user_id = $1 and kind = 'expense' limit 1",
      [USER_A],
    )).rows[0].id;

    await asUser(db, USER_A, async () => {
      const batch = (await db.query<{ id: string }>(
        `insert into public.import_batches (user_id, account_id, source_name, file_name, format, status, rows_total)
         values ($1, $2, 'CSV', 'extrato.csv', 'csv', 'processing', 1) returning id`,
        [USER_A, account],
      )).rows[0].id;

      const ingested = (await db.query<{ r: { status: string; transaction_id: string } }>(
        `select public.ingest_capture(p_token => null, p_source => 'csv', p_external_ref => 'import:x:1',
           p_description => 'COMPRA QUALQUER', p_amount_cents => -1500, p_date => '2026-10-10',
           p_method => 'debit', p_hint => null, p_last4 => null, p_account => $1, p_card => null,
           p_location => null, p_reason => null, p_intent => 'normal') as r`,
        [account],
      )).rows[0].r;
      expect(ingested.status).toBe("created");

      await db.query(
        "update public.transactions set batch_id = $1, category_id = $2, category_source = 'manual' where id = $3",
        [batch, category, ingested.transaction_id],
      );
      await db.query(
        "update public.import_batches set status = 'completed', rows_inserted = 1 where id = $1",
        [batch],
      );

      const { rows } = await db.query<{ batch_id: string; category_source: string }>(
        "select batch_id, category_source from public.transactions where id = $1",
        [ingested.transaction_id],
      );
      expect(rows[0]).toEqual({ batch_id: batch, category_source: "manual" });
    });
  });

  it("outro usuário não importa para a conta de A", async () => {
    await asUser(db, USER_B, async () => {
      await expect(
        db.query(
          `insert into public.import_batches (user_id, account_id, source_name, format)
           values ($1, $2, 'CSV', 'csv')`,
          [USER_B, account],
        ),
      ).rejects.toThrow();
    });
  });

  it("configurações: salva e altera, e cada usuário só vê as suas", async () => {
    const save = (paused: boolean) =>
      db.query(
        `insert into public.agent_settings (user_id, paused, auto_register, auto_categorize, min_confidence, automations)
         values ($1, $2, true, true, 80, $3)
         on conflict (user_id) do update set paused = excluded.paused`,
        [USER_A, paused, { recurring: false }],
      );
    await asUser(db, USER_A, async () => {
      await save(false);
      await save(true);
    });
    const seen = await asUser(db, USER_B, () => db.query("select * from public.agent_settings"));
    expect(seen.rows).toHaveLength(0);
    const mine = await asUser(db, USER_A, () =>
      db.query<{ paused: boolean }>("select paused from public.agent_settings"),
    );
    expect(mine.rows[0].paused).toBe(true);
  });

  it("vínculo de conta aceita a conexão do próprio usuário e recusa a alheia", async () => {
    const connectionB = (await asUser(db, USER_B, () =>
      db.query<{ id: string }>("select public.connect_provider('pluggy', 'item-de-b-123', null) as id"),
    )).rows[0].id;
    const connectionA = (await asUser(db, USER_A, () =>
      db.query<{ id: string }>("select public.connect_provider('pluggy', 'item-de-a-123', null) as id"),
    )).rows[0].id;

    const link = (id: string, pluggy: string) =>
      db.query(
        `insert into public.pluggy_links (user_id, pluggy_account_id, pluggy_type, label, account_id, connection_id)
         values ($1, $2, 'BANK', 'Conta', $3, $4)`,
        [USER_A, pluggy, account, id],
      );

    await asUser(db, USER_A, async () => {
      await link(connectionA, "pl-de-a");
      await expect(link(connectionB, "pl-alheio")).rejects.toThrow();
    });
  });

  it("alerta: usuário só marca como lido, sem editar o conteúdo", async () => {
    await db.query("insert into public.notifications (user_id, title) values ($1, 'Aviso')", [USER_A]);
    await asUser(db, USER_A, async () => {
      await db.query("update public.notifications set read_at = now() where read_at is null");
      await expect(db.query("update public.notifications set title = 'Editado'")).rejects.toThrow();
      await expect(db.query("insert into public.notifications (user_id, title) values ($1, 'Falso')", [USER_A])).rejects.toThrow();
    });
  });
});
