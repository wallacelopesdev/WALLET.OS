import { z } from "zod";
import { parseBRLToCents } from "@/lib/money";
import { ACCOUNT_KINDS, KINDS_WITHOUT_INSTITUTION } from "./constants";

export const accountIdSchema = z.string().uuid();

export const accountFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Informe um nome para a conta.")
      .max(80, "Use no máximo 80 caracteres."),
    institution: z.string().trim().max(80, "Use no máximo 80 caracteres."),
    kind: z.enum(ACCOUNT_KINDS, {
      errorMap: () => ({ message: "Selecione um tipo de conta." }),
    }),
    openingBalance: z.string().transform((value, ctx) => {
      const cents = parseBRLToCents(value);
      if (cents === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Informe um valor válido, como 1.234,56.",
        });
        return z.NEVER;
      }
      return cents;
    }),
  })
  .superRefine((data, ctx) => {
    if (!data.institution && !KINDS_WITHOUT_INSTITUTION.includes(data.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["institution"],
        message: "Informe a instituição financeira.",
      });
    }
  })
  .transform((data) => ({
    name: data.name,
    institution: data.institution || null,
    kind: data.kind,
    opening_balance_cents: data.openingBalance,
  }));

export type AccountInput = z.output<typeof accountFormSchema>;

type Identity = { id: string; name: string; institution: string | null };

const normalize = (text: string | null) =>
  (text ?? "").trim().toLocaleLowerCase("pt-BR");

/** Duas contas ativas com o mesmo nome na mesma instituição são quase sempre um engano. */
export function findDuplicateAccount(
  candidate: { name: string; institution: string | null },
  existing: Identity[],
  ignoreId?: string,
): Identity | undefined {
  return existing.find(
    (a) =>
      a.id !== ignoreId &&
      normalize(a.name) === normalize(candidate.name) &&
      normalize(a.institution) === normalize(candidate.institution),
  );
}
