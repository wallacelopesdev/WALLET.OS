import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn, formatBRL } from "@/lib/utils";
import { ACCOUNT_KIND_LABELS } from "../constants";
import type { Account } from "../queries";
import { AccountIcon } from "./account-icon";

export function AccountRow({ account }: { account: Account }) {
  const negative = account.balanceCents < 0;

  return (
    <li>
      <Link
        href={`/financeiro/contas/${account.id}`}
        className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3.5 transition-colors hover:bg-raised active:bg-raised"
      >
        <AccountIcon kind={account.kind} archived={account.archived} />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-sm font-medium", account.archived && "text-muted")}>
            {account.name}
          </p>
          <p className="truncate text-xs text-faint">
            {[account.institution, ACCOUNT_KIND_LABELS[account.kind]]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className={cn("text-sm font-medium tabular-nums", account.archived && "text-muted")}>
            {formatBRL(account.balanceCents)}
          </p>
          {negative && <p className="text-[11px] text-muted">Saldo negativo</p>}
        </div>
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-faint" />
      </Link>
    </li>
  );
}
