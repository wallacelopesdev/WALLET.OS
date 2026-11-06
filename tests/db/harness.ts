import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Postgres real em memória (WASM), sem Docker e sem tocar no banco de produção.
 * Reproduz o que o Supabase oferece às migrations: roles, grants padrão,
 * schema auth e auth.uid().
 */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on functions to anon, authenticated, service_role;
`;

function migration(file: string): string {
  const sql = readFileSync(
    path.resolve(process.cwd(), "supabase/migrations", file),
    "utf8",
  );
  // gen_random_uuid() é nativo do Postgres; a extensão não existe no PGlite puro.
  return sql.replace("create extension if not exists pgcrypto;", "");
}

export const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export async function createDatabase() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  await db.exec(migration("0001_init.sql"));
  return db;
}

/** Roda como o SQL Editor: tudo dentro de uma única transação. */
export async function applyMigration(db: PGlite, file: string) {
  await db.exec(`begin;\n${migration(file)}\ncommit;`);
}

export async function applyAccountsMigration(db: PGlite) {
  await applyMigration(db, "0002_accounts.sql");
}

export async function createUser(db: PGlite, id: string, email: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
}

/** Executa como o cliente autenticado do Supabase, sujeito a RLS e grants. */
export async function asUser<T>(
  db: PGlite,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await db.exec("set role authenticated");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

export async function asAnon<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  await db.exec("set role anon");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

let txCounter = 0;

export async function insertTx(
  db: PGlite,
  userId: string,
  accountId: string,
  amountCents: number,
): Promise<string> {
  txCounter += 1;
  const { rows } = await db.query<{ id: string }>(
    `insert into public.transactions
       (user_id, account_id, posted_at, description, amount_cents, dedupe_hash)
     values ($1, $2, '2026-11-01', 'Teste', $3, $4)
     returning id`,
    [userId, accountId, amountCents, `test:${txCounter}`],
  );
  return rows[0].id;
}

export async function insertAccount(
  db: PGlite,
  userId: string,
  name: string,
  openingCents = 0,
  kind = "checking",
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.bank_accounts (user_id, institution, name, kind, opening_balance_cents)
     values ($1, 'Banco Teste', $2, $3::public.account_kind, $4)
     returning id`,
    [userId, name, kind, openingCents],
  );
  return rows[0].id;
}

export async function balanceOf(db: PGlite, accountId: string): Promise<number> {
  const { rows } = await db.query<{ balance_cents: string | number }>(
    "select balance_cents from public.bank_accounts where id = $1",
    [accountId],
  );
  return Number(rows[0].balance_cents);
}
