import { z } from "zod";
import { isValidISODate, todayInSaoPaulo } from "@/lib/dates";
import { parseBRLToCents } from "@/lib/money";

export const idSchema = z.string().uuid();

const day = (message: string) =>
  z.coerce.number({ invalid_type_error: message }).int(message).min(1, message).max(31, message);

export const cardFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Informe um nome para o cartão.")
      .max(80, "Use no máximo 80 caracteres."),
    institution: z
      .string()
      .trim()
      .min(1, "Informe a instituição.")
      .max(80, "Use no máximo 80 caracteres."),
    last4: z
      .string()
      .trim()
      .refine(
        (value) => value === "" || /^\d{4}$/.test(value),
        "Informe só os 4 últimos dígitos. Nunca o número completo.",
      ),
    limit: z.string().transform((value, ctx) => {
      const cents = parseBRLToCents(value);
      if (cents === null || cents < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Informe um limite válido, como 5.000,00." });
        return z.NEVER;
      }
      return cents;
    }),
    closingDay: day("Informe um dia entre 1 e 31."),
    dueDay: day("Informe um dia entre 1 e 31."),
  })
  .transform((data) => ({
    name: data.name,
    institution: data.institution,
    last4: data.last4 || null,
    limit_cents: data.limit,
    closing_day: data.closingDay,
    due_day: data.dueDay,
  }));

const positiveAmount = z.string().transform((value, ctx) => {
  const cents = parseBRLToCents(value);
  if (cents === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Informe um valor válido, como 1.234,56." });
    return z.NEVER;
  }
  if (cents <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Informe um valor maior que zero." });
    return z.NEVER;
  }
  return cents;
});

const pastDate = z
  .string()
  .refine(isValidISODate, "Informe uma data válida.")
  .refine((date) => date >= "2000-01-01", "A data é antiga demais.")
  .refine((date) => date <= todayInSaoPaulo(), "A data não pode estar no futuro.");

const description = z
  .string()
  .trim()
  .min(1, "Informe uma descrição.")
  .max(200, "Use no máximo 200 caracteres.");

const categoryId = z
  .union([z.literal(""), z.string().uuid("Categoria inválida.")])
  .transform((value) => value || null);

export const purchaseFormSchema = z
  .object({
    requestId: z.string().uuid("Requisição inválida. Recarregue a página."),
    cardId: z.string().uuid("Selecione um cartão."),
    description,
    amount: positiveAmount,
    installments: z.coerce
      .number()
      .int("Número de parcelas inválido.")
      .min(1, "Número de parcelas inválido.")
      .max(48, "Use no máximo 48 parcelas."),
    postedAt: pastDate,
    categoryId,
    notes: z
      .string()
      .trim()
      .max(1000, "Use no máximo 1.000 caracteres.")
      .transform((value) => value || null),
  })
  .superRefine((data, ctx) => {
    if (data.amount < data.installments) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["installments"],
        message: "Cada parcela precisa ter pelo menos um centavo.",
      });
    }
  });

export const purchaseEditSchema = z.object({ description, categoryId });

export const paymentFormSchema = z.object({
  requestId: z.string().uuid("Requisição inválida. Recarregue a página."),
  invoiceId: z.string().uuid("Fatura inválida."),
  accountId: z.string().uuid("Selecione a conta do pagamento."),
  amount: positiveAmount,
  paidAt: pastDate,
});
