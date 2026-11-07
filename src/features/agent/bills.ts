"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dbErrorMessage, type ActionResult, type FieldErrors } from "@/lib/action-result";
import { requireUser } from "@/lib/auth";
import { isValidISODate } from "@/lib/dates";
import { parseBRLToCents } from "@/lib/money";

const billSchema = z.object({
  beneficiary: z.string().trim().min(1, "Informe o beneficiário.").max(120, "Use no máximo 120 caracteres."),
  amount: z.string().transform((value, ctx) => {
    const cents = parseBRLToCents(value);
    if (cents === null || cents <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Informe um valor maior que zero." });
      return z.NEVER;
    }
    return cents;
  }),
  dueDate: z.string().refine(isValidISODate, "Informe uma data válida."),
});

/** Cadastrar nunca marca como pago: isso depende de uma transação confirmada. */
export async function createBill(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = billSchema.safeParse({
    beneficiary: formData.get("beneficiary") ?? "",
    amount: formData.get("amount") ?? "",
    dueDate: formData.get("dueDate") ?? "",
  });
  if (!parsed.success) {
    const fieldErrors: FieldErrors = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    return { ok: false, error: "Revise os campos destacados.", fieldErrors };
  }

  const { error } = await auth.supabase.from("bills").insert({
    user_id: auth.user.id,
    beneficiary: parsed.data.beneficiary,
    amount_cents: parsed.data.amount,
    due_date: parsed.data.dueDate,
  });
  if (error) return { ok: false, error: dbErrorMessage(error, "bills.create") };

  revalidatePath("/", "layout");
  return { ok: true, message: "Boleto cadastrado." };
}

export async function dismissBill(id: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Boleto não encontrado." };

  const { error } = await auth.supabase.from("bills").update({ dismissed: true }).eq("id", id);
  if (error) return { ok: false, error: dbErrorMessage(error, "bills.dismiss") };

  revalidatePath("/", "layout");
  return { ok: true, message: "Boleto dispensado." };
}
