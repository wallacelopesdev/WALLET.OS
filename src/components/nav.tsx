"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ArrowLeftRight,
  BarChart3,
  Briefcase,
  CalendarDays,
  CheckSquare,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Mail,
  MoreHorizontal,
  Settings,
  Sparkles,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { signOut } from "@/app/login/actions";

type Item = { href: string; label: string; icon: LucideIcon };

export const NAV_ITEMS: Item[] = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/financeiro", label: "Financeiro", icon: Wallet },
  { href: "/cartoes", label: "Cartões", icon: CreditCard },
  { href: "/transacoes", label: "Transações", icon: ArrowLeftRight },
  { href: "/relatorios", label: "Relatórios", icon: BarChart3 },
  { href: "/chief-of-staff", label: "Chief of Staff", icon: Briefcase },
  { href: "/emails", label: "E-mails", icon: Mail },
  { href: "/agenda", label: "Agenda", icon: CalendarDays },
  { href: "/tarefas", label: "Tarefas", icon: CheckSquare },
  { href: "/assistant", label: "AI Assistant", icon: Sparkles },
  { href: "/configuracoes", label: "Configurações", icon: Settings },
];

const TAB_ITEMS = ["/overview", "/financeiro", "/tarefas", "/assistant"];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ email, demo }: { email: string | null; demo: boolean }) {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-ink px-4 pb-6 pt-8 md:flex">
      <div className="px-3">
        <p className="text-lg font-semibold tracking-tight">WALLET OS</p>
        <p className="mt-0.5 text-[11px] uppercase tracking-[0.25em] text-faint">
          Personal OS
        </p>
      </div>

      <nav className="mt-8 flex-1 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors",
                active
                  ? "bg-raised font-medium text-fg"
                  : "text-muted hover:bg-surface hover:text-fg",
              )}
            >
              <Icon className="h-[18px] w-[18px]" strokeWidth={active ? 2.2 : 1.8} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 border-t border-line px-3 pt-4">
        <p className="truncate text-xs text-muted">
          {demo ? "Modo demonstração" : (email ?? "Sessão ativa")}
        </p>
        <form action={signOut} className="mt-2">
          <button
            type="submit"
            className="flex items-center gap-2 text-sm text-muted transition-colors hover:text-fg"
          >
            <LogOut className="h-4 w-4" /> Sair
          </button>
        </form>
      </div>
    </aside>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const tabs = NAV_ITEMS.filter((i) => TAB_ITEMS.includes(i.href));

  return (
    <>
      <nav
        aria-label="Navegação principal"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-ink/80 backdrop-blur-xl md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="mx-auto grid max-w-md grid-cols-5">
          {tabs.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex flex-col items-center gap-1 py-2.5 text-[10px] transition-colors",
                    active ? "text-fg" : "text-faint",
                  )}
                >
                  <Icon className="h-5 w-5" strokeWidth={active ? 2.2 : 1.7} />
                  {label.replace("AI ", "")}
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-expanded={open}
              aria-haspopup="dialog"
              className="flex w-full flex-col items-center gap-1 py-2.5 text-[10px] text-faint transition-colors active:text-fg"
            >
              <MoreHorizontal className="h-5 w-5" strokeWidth={1.7} />
              Mais
            </button>
          </li>
        </ul>
      </nav>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Todas as seções"
          className="fixed inset-0 z-50 md:hidden"
        >
          <button
            type="button"
            aria-label="Fechar"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/70"
          />
          <div
            className="absolute inset-x-0 bottom-0 animate-sheet rounded-t-3xl border-t border-line-strong bg-surface px-5 pt-5"
            style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
          >
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm font-medium">Seções</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fechar"
                className="rounded-full p-1.5 text-muted active:bg-raised"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <ul className="grid grid-cols-3 gap-2">
              {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
                const active = isActive(pathname, href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      className={cn(
                        "flex h-20 flex-col items-center justify-center gap-2 rounded-2xl border text-xs transition-colors",
                        active
                          ? "border-fg bg-raised text-fg"
                          : "border-line text-muted active:bg-raised",
                      )}
                    >
                      <Icon className="h-5 w-5" strokeWidth={1.8} />
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
            <form action={signOut} className="mt-4">
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-line py-3 text-sm text-muted active:bg-raised"
              >
                <LogOut className="h-4 w-4" /> Sair
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
