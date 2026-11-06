import {
  Banknote,
  Building2,
  CircleDollarSign,
  Landmark,
  PiggyBank,
  Smartphone,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AccountKind } from "../constants";

const ICONS: Record<AccountKind, LucideIcon> = {
  checking: Landmark,
  savings: PiggyBank,
  digital: Smartphone,
  wallet: Wallet,
  cash: Banknote,
  investment: TrendingUp,
  other: CircleDollarSign,
};

export function AccountIcon({
  kind,
  archived,
  className,
}: {
  kind: AccountKind;
  archived?: boolean;
  className?: string;
}) {
  const Icon = ICONS[kind] ?? Building2;
  return (
    <span
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border",
        archived ? "border-line text-faint" : "border-line-strong bg-raised text-fg",
        className,
      )}
    >
      <Icon aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.8} />
    </span>
  );
}
