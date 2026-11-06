"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, fieldAria } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { INSTITUTION_SUGGESTIONS } from "@/features/accounts/constants";
import type { ActionResult } from "@/lib/action-result";
import { createCard, updateCard } from "../actions";
import type { Card } from "../queries";

export function CardForm({ card, onDone }: { card?: Card; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(card?.name ?? "");
  const [institution, setInstitution] = useState(card?.institution ?? "");
  const [last4, setLast4] = useState(card?.last4 ?? "");
  const [closingDay, setClosingDay] = useState(card ? String(card.closingDay) : "");
  const [dueDay, setDueDay] = useState(card ? String(card.dueDay) : "");

  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      const result = card
        ? await updateCard(card.id, previous, formData)
        : await createCard(previous, formData);
      if (result.ok) {
        toast.success(result.message);
        onDone();
      }
      return result;
    },
    null,
  );

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok ? state.error : null;

  return (
    <form action={action} className="space-y-4" noValidate autoComplete="off">
      <Field label="Nome" htmlFor="card-name" error={errors.name}>
        <Input
          {...fieldAria("card-name", errors.name)}
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Nubank Ultravioleta"
          maxLength={80}
        />
      </Field>

      <Field label="Instituição" htmlFor="card-institution" error={errors.institution}>
        <Input
          {...fieldAria("card-institution", errors.institution)}
          name="institution"
          value={institution}
          onChange={(e) => setInstitution(e.target.value)}
          list="card-institution-suggestions"
          placeholder="Ex.: Nubank"
          maxLength={80}
        />
        <datalist id="card-institution-suggestions">
          {INSTITUTION_SUGGESTIONS.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      </Field>

      <Field label="Limite total" htmlFor="card-limit" error={errors.limit}>
        <MoneyInput
          id="card-limit"
          name="limit"
          defaultCents={card?.limitCents ?? 0}
          invalid={Boolean(errors.limit)}
          describedBy={errors.limit ? "card-limit-error" : undefined}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Dia de fechamento" htmlFor="card-closing" error={errors.closingDay}>
          <Input
            {...fieldAria("card-closing", errors.closingDay)}
            name="closingDay"
            inputMode="numeric"
            value={closingDay}
            onChange={(e) => setClosingDay(e.target.value)}
            placeholder="1 a 31"
          />
        </Field>
        <Field label="Dia de vencimento" htmlFor="card-due" error={errors.dueDay}>
          <Input
            {...fieldAria("card-due", errors.dueDay)}
            name="dueDay"
            inputMode="numeric"
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
            placeholder="1 a 31"
          />
        </Field>
      </div>

      <Field
        label="4 últimos dígitos (opcional)"
        htmlFor="card-last4"
        error={errors.last4}
        hint="Nunca informe o número completo, o CVV ou a senha. O sistema não guarda esses dados."
      >
        <Input
          {...fieldAria("card-last4", errors.last4)}
          name="last4"
          inputMode="numeric"
          value={last4}
          onChange={(e) => setLast4(e.target.value)}
          placeholder="1234"
          maxLength={19}
          autoComplete="off"
        />
      </Field>

      {formError && (
        <p role="alert" className="rounded-xl border border-line-strong bg-raised px-4 py-3 text-sm">
          {formError}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
        <Button variant="secondary" onClick={onDone} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Salvando…" : card ? "Salvar alterações" : "Cadastrar cartão"}
        </Button>
      </div>
    </form>
  );
}
