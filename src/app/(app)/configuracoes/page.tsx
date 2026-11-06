import type { Metadata } from "next";
import { signOut } from "@/app/login/actions";
import { Card, CardTitle, PageHeader } from "@/components/ui/card";
import { getSessionInfo } from "@/lib/session";

export const metadata: Metadata = { title: "Configurações" };
export const dynamic = "force-dynamic";

const INTEGRATIONS = [
  { name: "Gmail", phase: 3 },
  { name: "Google Calendar", phase: 3 },
  { name: "Assistente de IA", phase: 4 },
];

export default async function SettingsPage() {
  const session = await getSessionInfo();

  return (
    <>
      <PageHeader title="Configurações" />

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="animate-rise">
          <CardTitle>Conta</CardTitle>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Acesso</dt>
              <dd>{session.demo ? "Modo demonstração" : "Autenticado"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">E-mail</dt>
              <dd className="truncate">{session.email ?? "—"}</dd>
            </div>
          </dl>
          <form action={signOut} className="mt-6">
            <button
              type="submit"
              className="rounded-xl border border-line-strong px-4 py-2.5 text-sm transition-colors hover:bg-raised"
            >
              Sair
            </button>
          </form>
        </Card>

        <Card className="animate-rise">
          <CardTitle>Integrações</CardTitle>
          <ul className="mt-2 divide-y divide-line">
            {INTEGRATIONS.map((i) => (
              <li key={i.name} className="flex items-center justify-between py-3.5 text-sm">
                <span>{i.name}</span>
                <span className="text-xs text-faint">Disponível na Fase {i.phase}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
