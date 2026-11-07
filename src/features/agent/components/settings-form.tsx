"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { saveAgentSettings } from "../actions";
import type { AgentSettings } from "../queries";

const AUTOMATIONS: { key: keyof AgentSettings["automations"]; label: string; hint: string }[] = [
  { key: "recurring", label: "Cobranças recorrentes", hint: "Identifica assinaturas e estima a próxima cobrança." },
  { key: "anomalies", label: "Despesas incomuns", hint: "Avisa quando um gasto foge muito do seu padrão." },
  { key: "duplicates", label: "Cobranças duplicadas", hint: "Avisa quando a mesma cobrança aparece duas vezes." },
  { key: "deadlines", label: "Vencimentos", hint: "Faturas, boletos e autorizações perto de vencer." },
  { key: "digests", label: "Resumos", hint: "Diário, semanal e mensal." },
];

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-7 w-12 shrink-0 rounded-full border transition-colors",
          checked ? "border-fg bg-fg" : "border-line-strong bg-raised",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full transition-[left]",
            checked ? "left-[1.4rem] bg-ink" : "left-0.5 bg-muted",
          )}
        />
      </button>
    </div>
  );
}

export function SettingsForm({ settings }: { settings: AgentSettings }) {
  const toast = useToast();
  const [value, setValue] = useState(settings);
  const [pending, startTransition] = useTransition();

  const save = () => {
    startTransition(async () => {
      const result = await saveAgentSettings(value);
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
    });
  };

  return (
    <>
      <Card className="animate-rise">
        <CardTitle>Autonomia</CardTitle>
        <div className="mt-2 divide-y divide-line">
          <Toggle
            label="Pausar o agente"
            hint="Nada se perde: o que chegar fica para revisar, e as sincronizações e automações param."
            checked={value.paused}
            onChange={(paused) => setValue({ ...value, paused })}
          />
          <Toggle
            label="Registrar automaticamente"
            hint="Desligado, toda movimentação recebida aguarda a sua revisão."
            checked={value.auto_register}
            onChange={(auto_register) => setValue({ ...value, auto_register })}
          />
          <Toggle
            label="Categorizar automaticamente"
            hint="O que você confirmou nunca é alterado pelo agente."
            checked={value.auto_categorize}
            onChange={(auto_categorize) => setValue({ ...value, auto_categorize })}
          />
        </div>
        <label className="mt-3 block text-sm font-medium" htmlFor="min-confidence">
          Confiança mínima para categorizar: <span className="tabular-nums">{value.min_confidence}%</span>
        </label>
        <input
          id="min-confidence"
          type="range"
          min={50}
          max={100}
          step={5}
          value={value.min_confidence}
          onChange={(e) => setValue({ ...value, min_confidence: Number(e.target.value) })}
          className="mt-2 w-full accent-[#fafafa]"
        />
        <p className="mt-3 text-xs text-muted">
          O agente nunca faz Pix, transferências, pagamentos, compras ou investimentos. Ele só organiza registros.
        </p>
      </Card>

      <Card className="mt-3 animate-rise">
        <CardTitle>Automações</CardTitle>
        <div className="mt-2 divide-y divide-line">
          {AUTOMATIONS.map((automation) => (
            <Toggle
              key={automation.key}
              label={automation.label}
              hint={automation.hint}
              checked={value.automations[automation.key]}
              onChange={(next) =>
                setValue({ ...value, automations: { ...value.automations, [automation.key]: next } })
              }
            />
          ))}
        </div>
      </Card>

      <div className="mt-3 flex justify-end">
        <Button disabled={pending} onClick={save}>
          {pending ? "Salvando…" : "Salvar configurações"}
        </Button>
      </div>
    </>
  );
}
