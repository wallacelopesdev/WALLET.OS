"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Copy, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, fieldAria } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-result";
import { cn, formatBRL, formatDateFull, formatTimestampDate } from "@/lib/utils";
import {
  createCaptureToken,
  discardPendingCapture,
  loadPluggyAccounts,
  resolvePendingCapture,
  revokeCaptureToken,
  savePluggyLink,
  syncPluggyNow,
  type TokenResult,
} from "../actions";
import type { PluggyAccount } from "../pluggy";
import type { CaptureToken, PendingEvent, PluggyLink } from "../queries";

export type TargetOption = { value: string; label: string; kind: "account" | "card" };

const SOURCE_LABELS: Record<string, string> = {
  apple_pay: "Apple Pay",
  notification: "Notificação",
  sms: "SMS",
  email: "E-mail",
  pluggy: "Open Finance",
};

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sem permissão de área de transferência: o texto continua selecionável.
    }
  };
  return (
    <div className="flex items-stretch gap-2">
      <code
        aria-label={label}
        className="min-w-0 flex-1 select-all break-all rounded-xl border border-line-strong bg-raised px-3 py-2.5 text-xs"
      >
        {value}
      </code>
      <Button variant="secondary" onClick={copy} aria-label={`Copiar ${label}`}>
        {copied ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
      </Button>
    </div>
  );
}

export function PendingPanel({
  events,
  targets,
}: {
  events: PendingEvent[];
  targets: TargetOption[];
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [chosen, setChosen] = useState<Record<string, string>>({});

  const run = (operation: () => Promise<ActionResult>) => {
    startTransition(async () => {
      const result = await operation();
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
    });
  };

  return (
    <Card id="pendentes" className="animate-rise">
      <CardTitle>Para revisar {events.length > 0 ? `(${events.length})` : ""}</CardTitle>
      {events.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nada para revisar"
          description="O que o sistema não conseguir classificar sozinho aparece aqui e só entra nos saldos depois da sua decisão."
        />
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {events.map((event) => {
            const options = targets.filter((t) => event.amountCents < 0 || t.kind === "account");
            // Registrar viraria despesa, e as compras da fatura já foram contadas.
            const isInvoicePayment = event.reason?.startsWith("Pagamento de fatura") ?? false;
            return (
              <li key={event.id} className="py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">{event.description}</p>
                    <p className="mt-0.5 text-xs text-faint">
                      {[formatDateFull(event.date), SOURCE_LABELS[event.source], event.location]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {event.reason && <p className="mt-1 text-xs text-muted">{event.reason}</p>}
                  </div>
                  <p
                    className={cn(
                      "shrink-0 text-sm font-medium tabular-nums",
                      event.amountCents > 0 && "text-positive",
                    )}
                  >
                    {event.amountCents > 0 ? "+" : ""}
                    {formatBRL(event.amountCents)}
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {!isInvoicePayment && (
                    <>
                      <Select
                        aria-label={`Destino de ${event.description}`}
                        value={chosen[event.id] ?? ""}
                        onChange={(e) => setChosen((c) => ({ ...c, [event.id]: e.target.value }))}
                        className="min-w-0 flex-1 basis-48 py-2"
                      >
                        <option value="">Escolha conta ou cartão</option>
                        {options.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                      <Button
                        disabled={pending || !chosen[event.id]}
                        onClick={() => run(() => resolvePendingCapture(event.id, chosen[event.id]))}
                      >
                        Registrar
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() => run(() => discardPendingCapture(event.id))}
                  >
                    Descartar
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function TokensPanel({ tokens }: { tokens: CaptureToken[] }) {
  const toast = useToast();
  const [name, setName] = useState("iPhone");
  const [revoking, setRevoking] = useState<CaptureToken | null>(null);
  const [pending, startTransition] = useTransition();
  const [state, action, creating] = useActionState<TokenResult | null, FormData>(
    createCaptureToken,
    null,
  );

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  return (
    <Card className="animate-rise">
      <CardTitle>Tokens do iPhone</CardTitle>
      <p className="mt-3 text-sm text-muted">
        Cada atalho usa um token para enviar dados, sem precisar da sua senha. Se perder o iPhone, revogue aqui.
      </p>

      {state?.ok && state.token && (
        <div className="mt-4 rounded-xl border border-fg p-4">
          <p className="text-sm font-medium">Copie agora: este token não será mostrado de novo.</p>
          <div className="mt-3">
            <CopyField value={state.token} label="token" />
          </div>
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {tokens.map((token) => (
            <li key={token.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{token.name}</p>
                <p className="text-xs text-faint">
                  {token.lastUsedAt
                    ? `Último uso em ${formatTimestampDate(token.lastUsedAt)}`
                    : `Criado em ${formatTimestampDate(token.createdAt)}, ainda sem uso`}
                </p>
              </div>
              <Button variant="ghost" onClick={() => setRevoking(token)}>
                Revogar
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form action={action} className="mt-4 flex flex-wrap items-end gap-2" noValidate>
        <div className="min-w-0 flex-1 basis-48">
          <Field label="Nome do novo token" htmlFor="token-name" error={errors.name}>
            <Input
              {...fieldAria("token-name", errors.name)}
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={creating}>
          {creating ? "Criando…" : "Criar token"}
        </Button>
      </form>

      <ConfirmDialog
        open={Boolean(revoking)}
        title={`Revogar ${revoking?.name ?? "token"}?`}
        description="Os atalhos que usam este token param de registrar lançamentos. Esta ação é permanente."
        confirmLabel="Revogar"
        pending={pending}
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          const target = revoking;
          if (!target) return;
          startTransition(async () => {
            const result = await revokeCaptureToken(target.id);
            setRevoking(null);
            if (result.ok) toast.success(result.message);
            else toast.error(result.error);
          });
        }}
      />
    </Card>
  );
}

export function PluggyPanel({
  configured,
  links,
  targets,
}: {
  configured: boolean;
  links: PluggyLink[];
  targets: TargetOption[];
}) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<PluggyAccount[] | null>(null);
  const [pending, startTransition] = useTransition();

  const lastSync = links
    .map((l) => l.lastSyncedAt)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);

  const load = () => {
    startTransition(async () => {
      const result = await loadPluggyAccounts();
      if (result.ok) setAccounts(result.accounts);
      else toast.error(result.error);
    });
  };

  const sync = () => {
    startTransition(async () => {
      const result = await syncPluggyNow();
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
    });
  };

  const link = (account: PluggyAccount, target: string) => {
    startTransition(async () => {
      const result = await savePluggyLink(account, target);
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
    });
  };

  const currentTarget = (id: string) => {
    const current = links.find((l) => l.pluggyAccountId === id);
    if (!current) return "";
    return current.accountId ? `account:${current.accountId}` : `card:${current.cardId}`;
  };

  return (
    <Card className="animate-rise">
      <CardTitle>Bancos (Open Finance)</CardTitle>
      {!configured ? (
        <p className="mt-3 text-sm text-muted">
          Ainda não configurado. Siga o passo a passo do README para criar sua conta no Meu Pluggy e
          preencher as variáveis no servidor. Nenhuma senha de banco passa pelo WALLET OS: a autorização
          acontece no próprio banco.
        </p>
      ) : (
        <>
          <p className="mt-3 text-sm text-muted">
            {links.length === 0
              ? "Ligue cada conta do banco a uma conta ou cartão daqui. Só entra o que acontecer depois de ligar: o histórico anterior já está nos saldos que você informou."
              : lastSync
                ? `${links.length} ligada(s). Última sincronização em ${formatTimestampDate(lastSync)}. Atualiza uma vez por dia.`
                : `${links.length} ligada(s), ainda sem sincronização.`}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" disabled={pending} onClick={load}>
              {accounts ? "Atualizar lista" : "Ver contas do banco"}
            </Button>
            {links.length > 0 && (
              <Button disabled={pending} onClick={sync}>
                {pending ? "Aguarde…" : "Sincronizar agora"}
              </Button>
            )}
          </div>
          {accounts && (
            accounts.length === 0 ? (
              <p className="mt-4 text-sm text-muted">
                Nenhuma conta encontrada. Confira se o banco já foi vinculado à sua aplicação no conector MeuPluggy.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {accounts.map((account) => (
                  <li key={account.id} className="py-3">
                    <p className="text-sm font-medium">{account.name}</p>
                    <p className="text-xs text-faint">
                      {[account.type === "CREDIT" ? "Cartão" : "Conta", account.number].filter(Boolean).join(" · ")}
                    </p>
                    <Select
                      aria-label={`Ligar ${account.name}`}
                      value={currentTarget(account.id)}
                      disabled={pending}
                      onChange={(e) => link(account, e.target.value)}
                      className="mt-2 py-2"
                    >
                      <option value="">Não sincronizar</option>
                      {targets
                        .filter((t) => (account.type === "CREDIT" ? t.kind === "card" : t.kind === "account"))
                        .map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                    </Select>
                  </li>
                ))}
              </ul>
            )
          )}
        </>
      )}
    </Card>
  );
}
