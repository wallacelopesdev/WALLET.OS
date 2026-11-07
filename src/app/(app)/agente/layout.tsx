import type { Metadata } from "next";
import { Card, PageHeader } from "@/components/ui/card";
import { AgentTabs } from "@/features/agent/components/agent-tabs";
import { isSupabaseConfigured } from "@/lib/env";

export const metadata: Metadata = { title: "Financial Agent" };

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  const demo = !isSupabaseConfigured();
  return (
    <>
      <PageHeader
        title="Financial Agent"
        subtitle="Organiza suas finanças a partir de fontes que você autorizou. Nunca movimenta dinheiro."
      />
      {demo ? (
        <Card className="animate-rise">
          <p className="text-sm text-muted">
            O agente não funciona em modo demonstração, porque depende de dados reais. Configure o Supabase para usá-lo.
          </p>
        </Card>
      ) : (
        <>
          <AgentTabs />
          {children}
        </>
      )}
    </>
  );
}
