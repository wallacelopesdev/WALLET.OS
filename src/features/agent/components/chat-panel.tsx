"use client";

import { useState, useTransition } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { formatBRL } from "@/lib/utils";
import { askAgent, type ChatReply } from "../chat/actions";

const SUGGESTIONS = [
  "Quanto gastei hoje?",
  "Quanto gastei com alimentação neste mês?",
  "Quais foram minhas maiores despesas?",
  "Quanto tenho de fatura para pagar?",
  "Quanto recebi por Pix?",
  "Quais assinaturas estão cobrando mensalmente?",
  "Quanto posso gastar até o fim do mês?",
  "Como está minha situação financeira?",
  "Onde estou gastando mais do que deveria?",
];

type Exchange = { id: number; question: string; reply: ChatReply };

export function ChatPanel({ aiEnabled }: { aiEnabled: boolean }) {
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [pending, startTransition] = useTransition();

  const ask = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    setQuestion("");
    startTransition(async () => {
      const reply = await askAgent(trimmed);
      setExchanges((list) => [{ id: list.length + 1, question: trimmed, reply }, ...list]);
    });
  };

  return (
    <>
      <Card className="animate-rise">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask(question);
          }}
          className="flex gap-2"
        >
          <Input
            aria-label="Pergunte ao agente"
            placeholder="Pergunte sobre as suas finanças"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={500}
            autoComplete="off"
          />
          <Button type="submit" aria-label="Enviar" disabled={pending || question.trim().length < 2}>
            <ArrowUp aria-hidden className="h-4 w-4" />
          </Button>
        </form>
        {exchanges.length === 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {SUGGESTIONS.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  onClick={() => ask(suggestion)}
                  disabled={pending}
                  className="min-h-9 rounded-full border border-line-strong px-3 text-xs text-muted transition-colors hover:bg-raised hover:text-fg"
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-faint">
          {aiEnabled
            ? "Perguntas conhecidas são respondidas aqui mesmo. As demais usam a Claude API, que recebe os resultados das consultas."
            : "Respondido aqui mesmo, com os seus dados, sem enviar nada a serviços externos."}{" "}
          O agente só consulta: não movimenta dinheiro.
        </p>
      </Card>

      {pending && <p className="mt-3 animate-pulse px-1 text-sm text-muted">Consultando seus dados…</p>}

      <ul className="mt-3 space-y-3">
        {exchanges.map(({ id, question: asked, reply }) => (
          <li key={id}>
            <Card className="animate-rise">
              <p className="text-xs text-muted">{asked}</p>
              {reply.ok ? (
                <>
                  <p className="mt-2 text-base leading-relaxed">{reply.answer.text}</p>
                  {reply.answer.rows.length > 0 && (
                    <ul className="mt-2 divide-y divide-line">
                      {reply.answer.rows.map((row, index) => (
                        <li key={index} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                          <span className="min-w-0 break-words">
                            {row.label}
                            {row.detail && <span className="block text-xs text-faint">{row.detail}</span>}
                          </span>
                          {row.amountCents !== undefined && (
                            <span className="shrink-0 tabular-nums">{formatBRL(row.amountCents)}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {reply.answer.source !== "—" && (
                    <p className="mt-3 text-xs text-faint">
                      Período: {reply.answer.period} · Origem: {reply.answer.source}
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-2 text-sm">{reply.error}</p>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
