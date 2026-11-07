"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { todayInSaoPaulo } from "@/lib/dates";
import { answerIntent, type Answer } from "./answers";
import { parseQuestion } from "./intents";

export type ChatReply =
  | { ok: true; answer: Answer; engine: "local" | "claude" }
  | { ok: false; error: string };

const questionSchema = z.string().trim().min(2).max(500);

const HELP =
  "Ainda não sei responder a isso sem a IA. Tente perguntar quanto gastou, suas maiores despesas, faturas, boletos, Pix recebidos, assinaturas, saldo, quanto pode gastar ou como está sua situação.";

/**
 * Responde primeiro com o interpretador local, sem enviar dados a ninguém. Só uma pergunta
 * que ele não entende vai para a Claude API, e só se a chave estiver configurada.
 */
export async function askAgent(question: string): Promise<ChatReply> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsedQuestion = questionSchema.safeParse(question);
  if (!parsedQuestion.success) return { ok: false, error: "Escreva uma pergunta de até 500 caracteres." };

  const { data: categories, error } = await auth.supabase
    .from("transaction_categories")
    .select("id,name,kind,archived");
  if (error) return { ok: false, error: "Não foi possível consultar os dados agora." };

  const today = todayInSaoPaulo();
  const parsed = parseQuestion(parsedQuestion.data, categories, today);

  try {
    if (parsed.intent !== "unknown") {
      const answer = await answerIntent(auth.supabase, parsed.intent, parsed.period, today, {
        id: parsed.categoryId,
        name: parsed.categoryName,
      });
      return { ok: true, engine: "local", answer };
    }

    const { askClaude, claudeEnabled } = await import("./claude");
    if (!claudeEnabled()) {
      return { ok: true, engine: "local", answer: { text: HELP, period: "—", source: "—", rows: [] } };
    }

    const text = await askClaude(parsedQuestion.data, today, async (intent, period, categoryName) => {
      const match = categoryName
        ? categories.find((c) => c.name.toLowerCase() === categoryName.toLowerCase())
        : undefined;
      return answerIntent(auth.supabase, intent, period, today, {
        id: match?.id ?? null,
        name: match?.name ?? null,
      });
    });

    if (!text) return { ok: false, error: "Não consegui responder a essa pergunta." };
    return {
      ok: true,
      engine: "claude",
      answer: { text, period: "Informado na resposta", source: "Consultas às suas transações, via Claude API", rows: [] },
    };
  } catch (failure) {
    console.error(`[chat] ${failure instanceof Error ? failure.name : "falha"}`);
    return { ok: false, error: "Não foi possível consultar os dados agora." };
  }
}
