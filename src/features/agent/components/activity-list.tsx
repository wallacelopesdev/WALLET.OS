import { formatBRL, formatTimestampDate } from "@/lib/utils";
import type { ActivityItem } from "../queries";

const LABELS: Record<string, string> = {
  "agent.transaction_registered": "Lançamento registrado",
  "agent.card_purchase_registered": "Compra no cartão identificada",
  "agent.pix_received": "Pix recebido e registrado",
  "agent.pix_sent": "Pix enviado e registrado",
  "agent.refund_registered": "Estorno registrado",
  "agent.invoice_payment_registered": "Pagamento de fatura reconhecido",
  "agent.bill_paid": "Boleto confirmado como pago",
  "agent.reconciled": "Conciliado com um lançamento existente",
  "agent.duplicate_blocked": "Duplicidade bloqueada",
  "agent.needs_review": "Aguardando sua revisão",
  "agent.review_resolved": "Revisão concluída",
  "agent.own_transfer_linked": "Transferência entre suas contas",
  "agent.recurring_identified": "Cobrança recorrente identificada",
  "agent.connection_added": "Conexão adicionada",
  "agent.connection_removed": "Conexão removida",
  "agent.connection_active": "Conexão funcionando",
  "agent.import_finished": "Importação de extrato concluída",
  "agent.connection_error": "Falha em uma conexão",
  "agent.connection_expired": "Autorização de banco vencida",
  "agent.run_success": "Sincronização concluída",
  "agent.run_partial": "Sincronização parcial",
  "agent.run_failed": "Sincronização falhou",
  "agent.paused": "Agente pausado",
  "agent.settings_updated": "Configurações alteradas",
};

export function ActivityList({ items }: { items: ActivityItem[] }) {
  return (
    <ol className="mt-2 divide-y divide-line">
      {items.map((item) => (
        <li key={item.id} className="flex items-start justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{LABELS[item.event] ?? "Atividade do agente"}</p>
            <p className="mt-0.5 break-words text-xs text-faint">
              {[formatTimestampDate(item.createdAt), item.description, item.reason].filter(Boolean).join(" · ")}
            </p>
          </div>
          {item.amountCents !== null && (
            <p className="shrink-0 text-sm tabular-nums text-muted">{formatBRL(item.amountCents)}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
