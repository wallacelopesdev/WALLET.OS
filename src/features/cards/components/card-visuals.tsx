import { cn, formatBRL, formatPercent } from "@/lib/utils";
import { INVOICE_STATUS_LABELS, type InvoiceStatus } from "../status";

export function LimitBar({
  name,
  usedCents,
  limitCents,
}: {
  name: string;
  usedCents: number;
  limitCents: number;
}) {
  const pct = limitCents > 0 ? Math.min(100, (usedCents / limitCents) * 100) : usedCents > 0 ? 100 : 0;
  return (
    <div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Limite utilizado do ${name}`}
      >
        <div
          className={cn("h-full rounded-full", pct >= 80 ? "bg-fg" : "bg-[#8c8c8c]")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1.5 flex justify-between gap-3 text-xs tabular-nums text-faint">
        <span>
          {formatBRL(usedCents)} de {formatBRL(limitCents)}
        </span>
        <span>{formatPercent(pct)}</span>
      </p>
    </div>
  );
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider",
        status === "overdue" && "border-fg bg-fg text-ink",
        status === "paid" && "border-line-strong text-positive",
        (status === "open" || status === "closed") && "border-line-strong text-muted",
      )}
    >
      {INVOICE_STATUS_LABELS[status]}
    </span>
  );
}
