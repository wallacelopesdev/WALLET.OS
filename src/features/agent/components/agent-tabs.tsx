"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/agente", label: "Painel" },
  { href: "/agente/revisao", label: "Revisão" },
  { href: "/agente/conversa", label: "Conversa" },
  { href: "/agente/atividade", label: "Atividade" },
  { href: "/agente/conexoes", label: "Conexões" },
  { href: "/agente/importar", label: "Importar" },
  { href: "/agente/boletos", label: "Boletos" },
  { href: "/agente/configuracoes", label: "Configurações" },
] as const;

export function AgentTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Seções do agente"
      className="-mx-4 mb-4 flex animate-rise gap-1 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none] border-line px-4 md:mx-0 md:px-0"
    >
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm transition-colors",
              active ? "border-fg font-medium text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
