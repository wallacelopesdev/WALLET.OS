import { MigrationRequiredError, isSchemaOutdated } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { TRANSACTIONS_PAGE_SIZE, type PaymentMethod } from "./constants";
import { escapeLike, type TransactionFilters } from "./schema";

export type TransactionItem = {
  id: string;
  postedAt: string;
  competenceDate: string | null;
  description: string;
  amountCents: number;
  kind: string;
  paymentMethod: PaymentMethod | null;
  notes: string | null;
  accountId: string | null;
  categoryId: string | null;
  transferGroupId: string | null;
  /** Só em transferências: as duas contas do par. */
  fromAccountId: string | null;
  toAccountId: string | null;
  /** Compras no cartão têm cartão e fatura, e nenhuma conta. */
  cardId: string | null;
  invoiceId: string | null;
  installmentNumber: number | null;
  installmentTotal: number | null;
};

type Row = {
  id: string;
  posted_at: string;
  competence_date: string | null;
  description: string;
  amount_cents: number;
  kind: string;
  payment_method: PaymentMethod | null;
  notes: string | null;
  account_id: string | null;
  category_id: string | null;
  transfer_group_id: string | null;
  card_id: string | null;
  invoice_id: string | null;
  installment_number: number | null;
  installment_total: number | null;
};

type LegRow = {
  transfer_group_id: string;
  account_id: string;
  amount_cents: number;
};

const COLUMNS =
  "id,posted_at,competence_date,description,amount_cents,kind,payment_method,notes,account_id,category_id,transfer_group_id,card_id,invoice_id,installment_number,installment_total";

function fail(error: { code?: string }, context: string): never {
  if (isSchemaOutdated(error)) throw new MigrationRequiredError();
  console.error(`[${context}] erro de banco, código ${error.code ?? "desconhecido"}`);
  throw new Error("Falha ao carregar os dados.");
}

export async function listTransactions(
  filters: TransactionFilters,
): Promise<{ items: TransactionItem[]; total: number }> {
  if (!isSupabaseConfigured()) {
    const { demoTransactions } = await import("@/lib/demo-data");
    const items = demoTransactions();
    return { items, total: items.length };
  }

  const supabase = await createClient();
  let query = supabase.from("transactions").select(COLUMNS, { count: "exact" });

  if (filters.q) query = query.ilike("description", `%${escapeLike(filters.q)}%`);
  if (filters.kind) query = query.eq("kind", filters.kind);
  if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
  if (filters.from) query = query.gte("posted_at", filters.from);
  if (filters.to) query = query.lte("posted_at", filters.to);

  // Com uma conta filtrada, mostra o lado dela. Sem filtro, cada transferência
  // aparece uma vez só, pelo lado da saída.
  query = filters.accountId
    ? query.eq("account_id", filters.accountId)
    : query.or("transfer_group_id.is.null,amount_cents.lt.0");

  switch (filters.sort) {
    case "data_asc":
      query = query.order("posted_at", { ascending: true }).order("created_at", { ascending: true });
      break;
    case "valor_desc":
      query = query.order("amount_abs_cents", { ascending: false }).order("posted_at", { ascending: false });
      break;
    case "valor_asc":
      query = query.order("amount_abs_cents", { ascending: true }).order("posted_at", { ascending: false });
      break;
    default:
      query = query.order("posted_at", { ascending: false }).order("created_at", { ascending: false });
  }

  const start = (filters.page - 1) * TRANSACTIONS_PAGE_SIZE;
  const { data, error, count } = await query
    .order("id")
    .range(start, start + TRANSACTIONS_PAGE_SIZE - 1);

  if (error) {
    // Página além do fim do resultado (por exemplo, depois de excluir lançamentos).
    if (error.code === "PGRST103") return { items: [], total: count ?? 0 };
    fail(error, "listTransactions");
  }

  const rows = data as unknown as Row[];
  const groups = rows.flatMap((r) => (r.transfer_group_id ? [r.transfer_group_id] : []));
  const legsByGroup = new Map<string, { from: string | null; to: string | null }>();

  if (groups.length > 0) {
    const { data: legs, error: legsError } = await supabase
      .from("transactions")
      .select("transfer_group_id,account_id,amount_cents")
      .in("transfer_group_id", groups);

    if (legsError) fail(legsError, "listTransactions.legs");

    for (const leg of legs as LegRow[]) {
      const entry = legsByGroup.get(leg.transfer_group_id) ?? { from: null, to: null };
      if (Number(leg.amount_cents) < 0) entry.from = leg.account_id;
      else entry.to = leg.account_id;
      legsByGroup.set(leg.transfer_group_id, entry);
    }
  }

  return {
    total: count ?? rows.length,
    items: rows.map((r) => {
      const legs = r.transfer_group_id ? legsByGroup.get(r.transfer_group_id) : undefined;
      return {
        id: r.id,
        postedAt: r.posted_at,
        competenceDate: r.competence_date,
        description: r.description,
        amountCents: Number(r.amount_cents),
        kind: r.kind,
        paymentMethod: r.payment_method,
        notes: r.notes,
        accountId: r.account_id,
        categoryId: r.category_id,
        transferGroupId: r.transfer_group_id,
        fromAccountId: legs?.from ?? null,
        toAccountId: legs?.to ?? null,
        cardId: r.card_id,
        invoiceId: r.invoice_id,
        installmentNumber: r.installment_number,
        installmentTotal: r.installment_total,
      };
    }),
  };
}
