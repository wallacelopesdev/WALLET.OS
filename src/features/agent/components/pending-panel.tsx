"use client";

import { useState, useTransition } from "react";
import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-result";
import { cn, formatBRL, formatDateFull } from "@/lib/utils";
import {
  discardPendingCapture,
  resolvePendingCapture,
  resolvePendingInvoice,
  reviewPendingCapture,
} from "../actions";
import type { OpenInvoice, PendingEvent } from "../queries";

export type TargetOption = { value: string; label: string; kind: "account" | "card" };

const SOURCE_LABELS: Record<string, string> = {
  apple_pay: "Apple Pay",
  notification: "Notificação",
  sms: "SMS",
  email: "E-mail",
  pluggy: "Open Finance",
  ofx: "Arquivo OFX",
  csv: "Arquivo CSV",
};

export function PendingPanel({
  events,
  targets,
  invoices,
}: {
  events: PendingEvent[];
  targets: TargetOption[];
  invoices: OpenInvoice[];
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
          description="O que o agente não conseguir decidir com segurança aparece aqui e só entra nos saldos depois da sua escolha."
        />
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {events.map((event) => {
            const options = targets.filter((t) => event.amountCents < 0 || t.kind === "account");
            // Registrar viraria despesa, e as compras da fatura já foram contadas.
            const isInvoicePayment = event.intent === "invoice_payment";
            const isTransfer = event.intent === "possible_transfer" && event.hasCandidate;
            const isDuplicate = event.intent === "normal" && event.hasCandidate;
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
                {(isTransfer || isDuplicate) && (
                  <div className="mt-3">
                    <Button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => run(() => reviewPendingCapture(event.id, isTransfer ? "transfer" : "same"))}
                    >
                      {isTransfer ? "É transferência entre minhas contas" : "É o mesmo lançamento"}
                    </Button>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {isInvoicePayment && invoices.length > 0 && (
                    <>
                      <Select
                        aria-label={`Fatura de ${event.description}`}
                        value={chosen[event.id] ?? ""}
                        onChange={(e) => setChosen((c) => ({ ...c, [event.id]: e.target.value }))}
                        className="min-w-0 flex-1 basis-48 py-2"
                      >
                        <option value="">Escolha a fatura</option>
                        {invoices.map((invoice) => (
                          <option key={invoice.id} value={invoice.id}>
                            {invoice.label}
                          </option>
                        ))}
                      </Select>
                      <Button
                        disabled={pending || !chosen[event.id]}
                        onClick={() => run(() => resolvePendingInvoice(event.id, chosen[event.id]))}
                      >
                        Ligar à fatura
                      </Button>
                    </>
                  )}
                  {!isInvoicePayment && (
                    <>
                      <Select
                        aria-label={`Destino de ${event.description}`}
                        value={chosen[event.id] ?? ""}
                        onChange={(e) => setChosen((c) => ({ ...c, [event.id]: e.target.value }))}
                        className="min-w-0 flex-1 basis-48 py-2"
                      >
                        <option value="">
                          {isTransfer || isDuplicate ? "Não é: registrar em..." : "Escolha conta ou cartão"}
                        </option>
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
