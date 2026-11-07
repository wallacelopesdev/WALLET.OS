"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select, fieldAria } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-result";
import { cn, formatTimestampDate } from "@/lib/utils";
import {
  addConnection,
  createCaptureToken,
  disconnectConnection,
  loadProviderAccounts,
  revokeCaptureToken,
  saveProviderLink,
  syncNow,
  type TokenResult,
} from "../actions";
import type { ProviderAccount } from "../providers/types";
import type { CaptureToken, Connection, ProviderLink } from "../queries";
import type { TargetOption } from "./pending-panel";

const STATUS: Record<Connection["status"], { label: string; className: string }> = {
  active: { label: "Ativa", className: "text-positive" },
  error: { label: "Com falha", className: "text-fg" },
  expired: { label: "Autorização vencida", className: "text-fg" },
  disconnected: { label: "Desconectada", className: "text-muted" },
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

export function TokensPanel({ tokens }: { tokens: CaptureToken[] }) {
  const toast = useToast();
  const [name, setName] = useState("iPhone");
  const [revoking, setRevoking] = useState<CaptureToken | null>(null);
  const [pending, startTransition] = useTransition();
  const [state, action, creating] = useActionState<TokenResult | null, FormData>(createCaptureToken, null);

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

export function ConnectionsPanel({
  configured,
  connections,
  links,
  targets,
}: {
  configured: boolean;
  connections: Connection[];
  links: ProviderLink[];
  targets: TargetOption[];
}) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<ProviderAccount[] | null>(null);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [itemId, setItemId] = useState("");
  const [pending, startTransition] = useTransition();
  const [state, action, adding] = useActionState<ActionResult | null, FormData>(async (previous, formData) => {
    const result = await addConnection(previous, formData);
    if (result.ok) {
      toast.success(result.message);
      setItemId("");
    }
    return result;
  }, null);

  const report = (result: ActionResult) => {
    if (result.ok) toast.success(result.message);
    else toast.error(result.error);
  };

  const load = () => {
    startTransition(async () => {
      const result = await loadProviderAccounts();
      if (result.ok) setAccounts(result.accounts);
      else toast.error(result.error);
    });
  };

  const currentTarget = (id: string) => {
    const current = links.find((l) => l.pluggyAccountId === id);
    if (!current) return "";
    return current.accountId ? `account:${current.accountId}` : `card:${current.cardId}`;
  };

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  if (!configured) {
    return (
      <Card className="animate-rise">
        <CardTitle>Bancos (Open Finance)</CardTitle>
        <p className="mt-3 text-sm text-muted">
          Ainda não configurado: faltam as credenciais da Pluggy no servidor. Siga o passo a passo do README para
          criar sua conta no Meu Pluggy. Nenhuma senha de banco passa pelo WALLET OS: a autorização acontece no próprio
          banco.
        </p>
      </Card>
    );
  }

  return (
    <Card className="animate-rise">
      <CardTitle>Bancos (Open Finance)</CardTitle>
      <p className="mt-3 text-sm text-muted">
        A autorização acontece no painel da Pluggy, e vale por 1 ano. Depois, copie o ID da conexão para cá. Só entra o
        que acontecer depois de ligar cada conta: o histórico anterior já está nos saldos que você informou.
      </p>

      {connections.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {connections.map((connection) => (
            <li key={connection.id} className="py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{connection.institution ?? "Conexão"}</p>
                  <p className={cn("text-xs", STATUS[connection.status].className)}>
                    {STATUS[connection.status].label}
                    {connection.lastErrorCode ? ` · ${connection.lastErrorCode}` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-faint">
                    {[
                      connection.lastSyncAt ? `Sincronizada em ${formatTimestampDate(connection.lastSyncAt)}` : "Ainda sem sincronização",
                      connection.consentExpiresAt ? `Autorização até ${formatTimestampDate(connection.consentExpiresAt)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Button variant="ghost" onClick={() => setRemoving(connection)}>
                  Desconectar
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={pending} onClick={load}>
          {accounts ? "Atualizar lista" : "Ver contas do banco"}
        </Button>
        {links.length > 0 && (
          <Button disabled={pending} onClick={() => startTransition(async () => report(await syncNow()))}>
            {pending ? "Aguarde…" : "Sincronizar agora"}
          </Button>
        )}
      </div>

      {accounts &&
        (accounts.length === 0 ? (
          <p className="mt-4 text-sm text-muted">
            Nenhuma conta encontrada. Confira o ID da conexão e se o banco foi vinculado ao conector MeuPluggy.
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
                  onChange={(e) => {
                    const target = e.target.value;
                    startTransition(async () => report(await saveProviderLink(account, target)));
                  }}
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
        ))}

      <form action={action} className="mt-4 flex flex-wrap items-end gap-2" noValidate>
        <div className="min-w-0 flex-1 basis-48">
          <Field label="ID da conexão no Meu Pluggy" htmlFor="connection-item" error={errors.itemId}>
            <Input
              {...fieldAria("connection-item", errors.itemId)}
              name="itemId"
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              autoComplete="off"
              maxLength={100}
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={adding}>
          {adding ? "Adicionando…" : "Adicionar conexão"}
        </Button>
      </form>

      <ConfirmDialog
        open={Boolean(removing)}
        title={`Desconectar ${removing?.institution ?? "conexão"}?`}
        description="O agente para de ler esta conexão e os vínculos são removidos. Os lançamentos já registrados continuam. Para revogar a autorização em si, faça isso no painel do Meu Pluggy ou no seu banco."
        confirmLabel="Desconectar"
        pending={pending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          if (!target) return;
          startTransition(async () => {
            report(await disconnectConnection(target.id));
            setRemoving(null);
          });
        }}
      />
    </Card>
  );
}
