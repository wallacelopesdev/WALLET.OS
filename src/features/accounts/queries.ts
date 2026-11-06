import { isSchemaOutdated } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { AccountKind } from "./constants";
import { accountIdSchema } from "./schema";

export type Account = {
  id: string;
  name: string;
  institution: string | null;
  kind: AccountKind;
  balanceCents: number;
  openingBalanceCents: number;
  archived: boolean;
  createdAt: string;
};

export type Movement = {
  id: string;
  postedAt: string;
  description: string;
  amountCents: number;
  kind: string;
  categoryName: string | null;
};

/** O código está à frente do banco: a migration 0002 ainda não foi aplicada. */
export class MigrationRequiredError extends Error {}

const ACCOUNT_COLUMNS =
  "id,name,institution,kind,balance_cents,opening_balance_cents,archived,created_at";

type AccountRow = {
  id: string;
  name: string;
  institution: string | null;
  kind: AccountKind;
  balance_cents: number;
  opening_balance_cents: number;
  archived: boolean;
  created_at: string;
};

const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  name: r.name,
  institution: r.institution,
  kind: r.kind,
  balanceCents: Number(r.balance_cents),
  openingBalanceCents: Number(r.opening_balance_cents),
  archived: r.archived,
  createdAt: r.created_at,
});

function fail(error: { code?: string }, context: string): never {
  if (isSchemaOutdated(error)) throw new MigrationRequiredError();
  console.error(`[${context}] erro de banco, código ${error.code ?? "desconhecido"}`);
  throw new Error("Falha ao carregar os dados.");
}

export async function listAccounts(): Promise<Account[]> {
  if (!isSupabaseConfigured()) {
    const { demoAccounts } = await import("@/lib/demo-data");
    return demoAccounts();
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bank_accounts")
    .select(ACCOUNT_COLUMNS)
    .order("name");

  if (error) fail(error, "listAccounts");
  return (data as AccountRow[]).map(toAccount);
}

/** O RLS devolve null para conta de outro usuário, igual a uma conta inexistente. */
export async function getAccount(id: string): Promise<Account | null> {
  if (!isSupabaseConfigured()) {
    const { demoAccounts } = await import("@/lib/demo-data");
    return demoAccounts().find((a) => a.id === id) ?? null;
  }

  if (!accountIdSchema.safeParse(id).success) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bank_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) fail(error, "getAccount");
  return data ? toAccount(data as AccountRow) : null;
}

type MovementRow = {
  id: string;
  posted_at: string;
  description: string;
  amount_cents: number;
  kind: string;
  transaction_categories: { name: string } | { name: string }[] | null;
};

export async function listAccountMovements(
  accountId: string,
  limit: number,
): Promise<{ movements: Movement[]; total: number }> {
  if (!isSupabaseConfigured()) {
    const { demoMovements } = await import("@/lib/demo-data");
    const movements = demoMovements(accountId);
    return { movements: movements.slice(0, limit), total: movements.length };
  }

  const supabase = await createClient();
  const { data, error, count } = await supabase
    .from("transactions")
    .select("id,posted_at,description,amount_cents,kind,transaction_categories(name)", {
      count: "exact",
    })
    .eq("account_id", accountId)
    .order("posted_at", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id")
    .range(0, limit - 1);

  if (error) fail(error, "listAccountMovements");

  const movements = (data as MovementRow[]).map((r) => {
    const category = Array.isArray(r.transaction_categories)
      ? r.transaction_categories[0]
      : r.transaction_categories;
    return {
      id: r.id,
      postedAt: r.posted_at,
      description: r.description,
      amountCents: Number(r.amount_cents),
      kind: r.kind,
      categoryName: category?.name ?? null,
    };
  });

  return { movements, total: count ?? movements.length };
}
