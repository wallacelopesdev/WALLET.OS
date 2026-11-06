"use client";

import { useState } from "react";
import { centsToInput, parseBRLToCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { inputClass } from "./field";

type Props = {
  id: string;
  name: string;
  defaultCents?: number;
  /** Mostra um seletor de sinal: o teclado decimal do iPhone não tem a tecla de menos. */
  allowNegative?: boolean;
  invalid?: boolean;
  describedBy?: string;
};

/**
 * Campo de valor em reais. Envia o texto, e o servidor faz a conversão e a
 * validação definitivas em centavos.
 */
export function MoneyInput({
  id,
  name,
  defaultCents = 0,
  allowNegative = false,
  invalid,
  describedBy,
}: Props) {
  const [negative, setNegative] = useState(defaultCents < 0);
  const [text, setText] = useState(centsToInput(Math.abs(defaultCents)));

  const tidy = () => {
    const cents = parseBRLToCents(text);
    if (cents === null) return;
    setText(centsToInput(Math.abs(cents)));
    if (allowNegative && cents < 0) setNegative(true);
  };

  return (
    <div className="flex gap-2">
      {allowNegative && (
        <button
          type="button"
          onClick={() => setNegative((v) => !v)}
          aria-pressed={negative}
          aria-label={negative ? "Valor negativo. Tornar positivo" : "Valor positivo. Tornar negativo"}
          className="min-h-11 w-12 shrink-0 rounded-xl border border-line-strong text-lg tabular-nums transition-colors hover:bg-raised active:bg-raised"
        >
          {negative ? "−" : "+"}
        </button>
      )}
      <div className="relative min-w-0 flex-1">
        <span
          aria-hidden
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted"
        >
          R$
        </span>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={tidy}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          className={cn(inputClass, "pl-12 tabular-nums")}
        />
      </div>
      <input
        type="hidden"
        name={name}
        value={`${negative && !text.trim().startsWith("-") ? "-" : ""}${text}`}
      />
    </div>
  );
}
