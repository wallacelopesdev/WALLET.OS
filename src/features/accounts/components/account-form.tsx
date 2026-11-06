"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, fieldAria } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-result";
import { createAccount, updateAccount } from "../actions";
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  INSTITUTION_SUGGESTIONS,
  KINDS_WITHOUT_INSTITUTION,
  type AccountKind,
} from "../constants";
import type { Account } from "../queries";

export function AccountForm({
  account,
  onDone,
}: {
  account?: Account;
  onDone: () => void;
}) {
  const toast = useToast();
  // Campos controlados: o React 19 reinicia os não controlados após cada envio,
  // o que apagaria o que foi digitado quando a validação falha.
  const [name, setName] = useState(account?.name ?? "");
  const [institution, setInstitution] = useState(account?.institution ?? "");
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? "checking");
  // O aviso sai aqui, e não em um efeito: ao criar a primeira conta, o estado vazio
  // que contém este formulário é substituído pela lista e ele é desmontado.
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      const result = account
        ? await updateAccount(account.id, previous, formData)
        : await createAccount(previous, formData);
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
  const institutionOptional = KINDS_WITHOUT_INSTITUTION.includes(kind);
  const openingHint = account
    ? "Alterar este valor desloca o saldo atual pela diferença."
    : "Quanto havia na conta no momento do cadastro. Pode ser negativo.";

  return (
    <form action={action} className="space-y-4" noValidate>
      <Field label="Nome" htmlFor="account-name" error={errors.name}>
        <Input
          {...fieldAria("account-name", errors.name)}
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Conta principal"
          maxLength={80}
          autoComplete="off"
          required
        />
      </Field>

      <Field label="Tipo" htmlFor="account-kind" error={errors.kind}>
        <Select
          {...fieldAria("account-kind", errors.kind)}
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as AccountKind)}
        >
          {ACCOUNT_KINDS.map((k) => (
            <option key={k} value={k}>
              {ACCOUNT_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label={institutionOptional ? "Instituição (opcional)" : "Instituição"}
        htmlFor="account-institution"
        error={errors.institution}
      >
        <Input
          {...fieldAria("account-institution", errors.institution)}
          name="institution"
          value={institution}
          onChange={(e) => setInstitution(e.target.value)}
          list="institution-suggestions"
          placeholder="Ex.: Nubank"
          maxLength={80}
          autoComplete="off"
        />
        <datalist id="institution-suggestions">
          {INSTITUTION_SUGGESTIONS.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>

      <Field
        label="Saldo inicial"
        htmlFor="account-opening"
        hint={openingHint}
        error={errors.openingBalance}
      >
        <MoneyInput
          id="account-opening"
          name="openingBalance"
          defaultCents={account?.openingBalanceCents ?? 0}
          allowNegative
          invalid={Boolean(errors.openingBalance)}
          describedBy={errors.openingBalance ? "account-opening-error" : undefined}
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
          {pending ? "Salvando…" : account ? "Salvar alterações" : "Criar conta"}
        </Button>
      </div>
    </form>
  );
}
