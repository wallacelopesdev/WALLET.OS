import { addMonths, monthRange } from "@/lib/dates";
import type { createClient } from "@/lib/supabase/server";
import { formatBRL, formatDateFull } from "@/lib/utils";
import { totalExpenses, totalIncome, type Intent, type Period } from "./intents";

type Client = Awaited<ReturnType<typeof createClient>>;

export type AnswerRow = { label: string; detail?: string; amountCents?: number };

export type Answer = {
  text: string;
  /** Período analisado e origem dos dados: toda resposta os declara. */
  period: string;
  source: string;
  rows: AnswerRow[];
};

type Tx = {
  amount_cents: number;
  kind: string;
  posted_at: string;
  description: string;
  category_id: string | null;
  payment_method: string | null;
};

const TX_SOURCE = "Transações registradas no WALLET OS";

async function loadTransactions(supabase: Client, from: string, to: string, categoryId?: string | null) {
  let query = supabase
    .from("transactions")
    .select("amount_cents,kind,posted_at,description,category_id,payment_method")
    .gte("posted_at", from)
    .lte("posted_at", to)
    .limit(5000);
  if (categoryId) query = query.eq("category_id", categoryId);
  const { data, error } = await query;
  if (error) throw new Error(`Banco respondeu ${error.code ?? "erro"}`);
  return (data as Tx[]).map((t) => ({ ...t, amountCents: Number(t.amount_cents) }));
}

async function openInvoices(supabase: Client) {
  const [invoices, cards] = await Promise.all([
    supabase
      .from("card_invoices")
      .select("total_cents,paid_cents,due_date,closing_date,card_id")
      .neq("status", "paid")
      .order("due_date"),
    supabase.from("credit_cards").select("id,name"),
  ]);
  const error = invoices.error ?? cards.error;
  if (error) throw new Error(`Banco respondeu ${error.code ?? "erro"}`);
  const names = new Map((cards.data ?? []).map((c) => [c.id as string, c.name as string]));
  return (invoices.data ?? [])
    .map((i) => ({
      remaining: Number(i.total_cents) - Number(i.paid_cents),
      due: i.due_date as string,
      closing: i.closing_date as string,
      card: names.get(i.card_id as string) ?? "Cartão",
    }))
    .filter((i) => i.remaining > 0);
}

async function accountsBalance(supabase: Client) {
  const { data, error } = await supabase.from("bank_accounts").select("balance_cents").eq("archived", false);
  if (error) throw new Error(`Banco respondeu ${error.code ?? "erro"}`);
  return { total: (data ?? []).reduce((sum, a) => sum + Number(a.balance_cents), 0), count: data?.length ?? 0 };
}

async function openBills(supabase: Client, until: string) {
  const { data, error } = await supabase
    .from("bills")
    .select("beneficiary,amount_cents,due_date")
    .is("paid_transaction_id", null)
    .eq("dismissed", false)
    .lte("due_date", until)
    .order("due_date");
  if (error) throw new Error(`Banco respondeu ${error.code ?? "erro"}`);
  return (data ?? []).map((b) => ({ name: b.beneficiary as string, amount: Number(b.amount_cents), due: b.due_date as string }));
}

async function activeRecurring(supabase: Client) {
  const { data, error } = await supabase
    .from("recurring_charges")
    .select("description,amount_cents,period,next_date")
    .eq("dismissed", false)
    .order("next_date");
  if (error) throw new Error(`Banco respondeu ${error.code ?? "erro"}`);
  return (data ?? []).map((r) => ({
    name: r.description as string,
    amount: Number(r.amount_cents),
    period: r.period as string,
    next: r.next_date as string,
  }));
}

const NO_DATA = "Não encontrei dados suficientes";

/** O período como complemento da frase: "hoje", "no mês passado", "em março de 2026". */
export function during(period: Period): string {
  const label = period.label;
  if (["hoje", "ontem", "este mês", "esta semana"].includes(label)) return label;
  if (label === "mês passado") return "no mês passado";
  if (label === "semana passada") return "na semana passada";
  if (label.startsWith("últimos")) return `nos ${label}`;
  return `em ${label}`;
}

export async function answerIntent(
  supabase: Client,
  intent: Intent,
  period: Period,
  today: string,
  category: { id: string | null; name: string | null } = { id: null, name: null },
): Promise<Answer> {
  const base = { period: period.label, source: TX_SOURCE, rows: [] as AnswerRow[] };

  switch (intent) {
    case "spent": {
      const rows = await loadTransactions(supabase, period.from, period.to, category.id);
      const counted = rows.filter((r) => r.kind !== "transfer" && r.kind !== "invoice_payment");
      if (counted.length === 0) {
        return { ...base, text: `${NO_DATA}: nenhuma despesa registrada ${category.name ? `em ${category.name} ` : ""}${during(period)}.` };
      }
      const total = totalExpenses(rows);
      return {
        ...base,
        text: `Você gastou ${formatBRL(total)}${category.name ? ` com ${category.name}` : ""} ${during(period)}.`,
      };
    }

    case "received": {
      const rows = await loadTransactions(supabase, period.from, period.to, category.id);
      const total = totalIncome(rows);
      if (total === 0) return { ...base, text: `${NO_DATA}: nenhuma receita registrada ${during(period)}.` };
      return { ...base, text: `Você recebeu ${formatBRL(total)}${category.name ? ` em ${category.name}` : ""} ${during(period)}.` };
    }

    case "top_expenses": {
      const rows = await loadTransactions(supabase, period.from, period.to, category.id);
      const expenses = rows
        .filter((r) => r.amountCents < 0 && r.kind !== "transfer" && r.kind !== "invoice_payment")
        .sort((a, b) => a.amountCents - b.amountCents)
        .slice(0, 5);
      if (expenses.length === 0) return { ...base, text: `${NO_DATA}: nenhuma despesa registrada ${during(period)}.` };
      return {
        ...base,
        text: `Sua maior despesa ${during(period)} foi ${expenses[0].description}, de ${formatBRL(-expenses[0].amountCents)}.`,
        rows: expenses.map((e) => ({
          label: e.description,
          detail: formatDateFull(e.posted_at),
          amountCents: -e.amountCents,
        })),
      };
    }

    case "invoices": {
      const invoices = await openInvoices(supabase);
      const source = "Faturas de cartão registradas no WALLET OS";
      if (invoices.length === 0) return { ...base, period: "atual", source, text: "Não há faturas em aberto registradas." };
      const closed = invoices.filter((i) => i.closing <= today);
      const toPay = closed.reduce((sum, i) => sum + i.remaining, 0);
      const future = invoices.reduce((sum, i) => sum + i.remaining, 0) - toPay;
      return {
        ...base,
        period: "atual",
        source,
        text: `Você tem ${formatBRL(toPay)} em faturas fechadas para pagar, e mais ${formatBRL(future)} em faturas ainda abertas ou futuras.`,
        rows: invoices.slice(0, 6).map((i) => ({ label: i.card, detail: `Vence em ${formatDateFull(i.due)}`, amountCents: i.remaining })),
      };
    }

    case "bills": {
      const until = monthRange(addMonths(today.slice(0, 7), 1)).to;
      const bills = await openBills(supabase, until);
      const source = "Boletos cadastrados por você. O Open Finance não informa boletos pendentes";
      if (bills.length === 0) {
        return { ...base, period: "até o fim do próximo mês", source, text: "Não há boletos em aberto cadastrados com vencimento próximo." };
      }
      return {
        ...base,
        period: "até o fim do próximo mês",
        source,
        text: `Você tem ${bills.length} ${bills.length === 1 ? "boleto" : "boletos"} em aberto, somando ${formatBRL(bills.reduce((s, b) => s + b.amount, 0))}.`,
        rows: bills.map((b) => ({ label: b.name, detail: `Vence em ${formatDateFull(b.due)}`, amountCents: b.amount })),
      };
    }

    case "pix_received": {
      const rows = await loadTransactions(supabase, period.from, period.to);
      const pix = rows.filter((r) => r.payment_method === "pix" && r.kind === "income");
      if (pix.length === 0) return { ...base, text: `${NO_DATA}: nenhum Pix recebido registrado ${during(period)}.` };
      return { ...base, text: `Você recebeu ${formatBRL(pix.reduce((s, r) => s + r.amountCents, 0))} por Pix ${during(period)}, em ${pix.length} ${pix.length === 1 ? "lançamento" : "lançamentos"}.` };
    }

    case "sent_to_others": {
      const rows = await loadTransactions(supabase, period.from, period.to);
      // Transferências entre suas contas têm tipo próprio e não entram aqui.
      const sent = rows.filter((r) => (r.payment_method === "pix" || r.payment_method === "transfer") && r.kind === "expense");
      if (sent.length === 0) return { ...base, text: `${NO_DATA}: nenhuma transferência para terceiros registrada ${during(period)}.` };
      return {
        ...base,
        text: `Você transferiu ${formatBRL(sent.reduce((s, r) => s - r.amountCents, 0))} para outras pessoas ${during(period)}.`,
        rows: [...sent].sort((a, b) => a.amountCents - b.amountCents).slice(0, 5).map((r) => ({
          label: r.description,
          detail: formatDateFull(r.posted_at),
          amountCents: -r.amountCents,
        })),
      };
    }

    case "subscriptions": {
      const recurring = await activeRecurring(supabase);
      const source = "Cobranças recorrentes identificadas pelo agente nas suas transações";
      if (recurring.length === 0) {
        return { ...base, period: "últimos 13 meses", source, text: `${NO_DATA}: é preciso de pelo menos 3 cobranças parecidas para identificar uma recorrência.` };
      }
      const monthly = recurring.filter((r) => r.period === "monthly").reduce((s, r) => s + r.amount, 0);
      return {
        ...base,
        period: "últimos 13 meses",
        source,
        text: `Identifiquei ${recurring.length} ${recurring.length === 1 ? "cobrança recorrente" : "cobranças recorrentes"}, com ${formatBRL(monthly)} por mês nas mensais.`,
        rows: recurring.map((r) => ({ label: r.name, detail: `Próxima em ${formatDateFull(r.next)}`, amountCents: r.amount })),
      };
    }

    case "balance": {
      const { total, count } = await accountsBalance(supabase);
      if (count === 0) return { ...base, period: "atual", source: "Contas cadastradas", text: "Você ainda não tem contas ativas cadastradas." };
      return { ...base, period: "atual", source: "Saldo das contas ativas no WALLET OS", text: `O saldo das suas ${count} ${count === 1 ? "conta ativa" : "contas ativas"} é ${formatBRL(total)}.` };
    }

    case "can_spend": {
      const monthEnd = monthRange(today.slice(0, 7)).to;
      const [{ total, count }, invoices, bills, recurring] = await Promise.all([
        accountsBalance(supabase),
        openInvoices(supabase),
        openBills(supabase, monthEnd),
        activeRecurring(supabase),
      ]);
      const source = "Estimativa com saldo, faturas, boletos e recorrências registrados. Não considera o que não foi registrado";
      if (count === 0) return { ...base, period: "até o fim do mês", source, text: `${NO_DATA}: cadastre suas contas para eu estimar.` };

      const invoiceDue = invoices.filter((i) => i.due <= monthEnd).reduce((s, i) => s + i.remaining, 0);
      const billsDue = bills.reduce((s, b) => s + b.amount, 0);
      const recurringDue = recurring.filter((r) => r.next >= today && r.next <= monthEnd).reduce((s, r) => s + r.amount, 0);
      const free = total - invoiceDue - billsDue - recurringDue;
      return {
        ...base,
        period: "até o fim do mês",
        source,
        text:
          free >= 0
            ? `Pela estimativa, você pode gastar até ${formatBRL(free)} até o fim do mês.`
            : `Pela estimativa, faltam ${formatBRL(-free)} para cobrir os compromissos até o fim do mês.`,
        rows: [
          { label: "Saldo das contas", amountCents: total },
          { label: "Faturas a vencer", amountCents: -invoiceDue },
          { label: "Boletos a vencer", amountCents: -billsDue },
          { label: "Recorrências previstas", amountCents: -recurringDue },
        ],
      };
    }

    case "situation": {
      const monthStart = `${today.slice(0, 7)}-01`;
      const [{ total, count }, rows, invoices, pending] = await Promise.all([
        accountsBalance(supabase),
        loadTransactions(supabase, monthStart, today),
        openInvoices(supabase),
        supabase.from("capture_events").select("id", { count: "exact", head: true }).eq("status", "pending"),
      ]);
      if (count === 0 && rows.length === 0) {
        return { ...base, period: "este mês", text: `${NO_DATA}: cadastre suas contas e lançamentos.` };
      }
      const income = totalIncome(rows);
      const expenses = totalExpenses(rows);
      const openTotal = invoices.reduce((s, i) => s + i.remaining, 0);
      return {
        ...base,
        period: "este mês",
        text: `Este mês você recebeu ${formatBRL(income)} e gastou ${formatBRL(expenses)}, um resultado de ${formatBRL(income - expenses)}. Suas contas têm ${formatBRL(total)} e há ${formatBRL(openTotal)} em faturas por pagar, incluindo parcelas futuras.${pending.count ? ` ${pending.count} lançamentos aguardam sua revisão e ainda não estão nesses números.` : ""}`,
      };
    }

    case "overspending": {
      const month = today.slice(0, 7);
      const from = monthRange(addMonths(month, -3)).from;
      const [rows, categories] = await Promise.all([
        loadTransactions(supabase, from, today),
        supabase.from("transaction_categories").select("id,name"),
      ]);
      const names = new Map((categories.data ?? []).map((c) => [c.id as string, c.name as string]));
      const current = new Map<string, number>();
      const previous = new Map<string, number>();
      for (const row of rows) {
        if (row.kind !== "expense" || !row.category_id) continue;
        const target = row.posted_at.startsWith(month) ? current : previous;
        target.set(row.category_id, (target.get(row.category_id) ?? 0) - row.amountCents);
      }
      const period = "este mês, comparado à média dos 3 meses anteriores";
      if (previous.size === 0) {
        return { ...base, period, text: `${NO_DATA}: preciso de meses anteriores categorizados para comparar.` };
      }
      const rises = [...current.entries()]
        .map(([id, spent]) => {
          const average = Math.round((previous.get(id) ?? 0) / 3);
          return { name: names.get(id) ?? "Categoria", spent, average, over: spent - average };
        })
        .filter((c) => c.average > 0 && c.over > 0)
        .sort((a, b) => b.over - a.over)
        .slice(0, 5);
      if (rises.length === 0) return { ...base, period, text: "Nenhuma categoria está acima da sua média dos últimos 3 meses." };
      return {
        ...base,
        period,
        text: `O maior aumento é em ${rises[0].name}: ${formatBRL(rises[0].spent)} contra uma média de ${formatBRL(rises[0].average)}.`,
        rows: rises.map((c) => ({ label: c.name, detail: `Média de ${formatBRL(c.average)}`, amountCents: c.spent })),
      };
    }
  }
}
