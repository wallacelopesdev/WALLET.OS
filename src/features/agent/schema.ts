import { z } from "zod";
import { parseBRLToCents } from "@/lib/money";
import { reaisToCents } from "./providers/pluggy-map";

/**
 * Valor como os Atalhos entregam: texto com moeda ("R$ 12,34", "12,34 BRL") ou número.
 * Moeda estrangeira é recusada, pois não há conversão.
 */
export function parseCaptureAmount(input: unknown): number | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return null;
    return reaisToCents(input);
  }
  if (typeof input !== "string") return null;
  const text = input.replace(/ /g, " ").trim().replace(/^BRL\s*/i, "").replace(/\s*BRL$/i, "");
  const cents = parseBRLToCents(text);
  return cents !== null && cents > 0 ? cents : null;
}

const shortText = z.string().trim().max(200).optional();

export const captureBodySchema = z
  .object({
    source: z.enum(["apple_pay", "notification", "sms", "email"]),
    merchant: shortText,
    amount: z.union([z.string().max(40), z.number()]).optional(),
    /** Nome do cartão ou da conta, definido em cada atalho. */
    card: shortText,
    text: z.string().max(2000).optional(),
    location: shortText,
  })
  .refine((body) => Boolean(body.text) || body.amount !== undefined, {
    message: "Informe text ou amount.",
  });

export type CaptureBody = z.output<typeof captureBodySchema>;

export const tokenNameSchema = z
  .string()
  .trim()
  .min(1, "Dê um nome, como iPhone.")
  .max(60, "Use no máximo 60 caracteres.");

export const uuidSchema = z.string().uuid();

/** Destino escolhido em um seletor: `account:<id>` ou `card:<id>`. */
export function parseTarget(value: string): { account: string | null; card: string | null } | null {
  const [kind, id] = value.split(":");
  if (!uuidSchema.safeParse(id).success) return null;
  if (kind === "account") return { account: id, card: null };
  if (kind === "card") return { account: null, card: id };
  return null;
}
