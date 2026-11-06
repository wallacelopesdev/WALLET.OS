import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "contas", href: "/financeiro", label: "Contas" },
  { key: "categorias", href: "/financeiro/categorias", label: "Categorias" },
] as const;

export function FinanceTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <nav aria-label="Seções do financeiro" className="mb-4 flex animate-rise gap-1 border-b border-line">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={active === tab.key ? "page" : undefined}
          className={cn(
            "-mb-px flex min-h-11 items-center border-b-2 px-3 text-sm transition-colors",
            active === tab.key
              ? "border-fg font-medium text-fg"
              : "border-transparent text-muted hover:text-fg",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
