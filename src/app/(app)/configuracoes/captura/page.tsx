import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { MigrationNotice } from "@/components/migration-notice";
import { Card, CardTitle, PageHeader } from "@/components/ui/card";
import { listAccounts } from "@/features/accounts/queries";
import {
  CopyField,
  PendingPanel,
  PluggyPanel,
  TokensPanel,
  type TargetOption,
} from "@/features/capture/components/capture-panels";
import { pluggyEnv } from "@/features/capture/pluggy";
import { getCaptureData } from "@/features/capture/queries";
import { listCards } from "@/features/cards/queries";
import { MigrationRequiredError } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";

export const metadata: Metadata = { title: "Captura automática" };
export const dynamic = "force-dynamic";

const SUBTITLE = "Lançamentos entrando sozinhos, do iPhone e dos seus bancos.";

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="mt-3 space-y-2 text-sm text-muted">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="w-4 shrink-0 tabular-nums text-faint">{i + 1}.</span>
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ol>
  );
}

export default async function CapturePage() {
  const back = (
    <Link
      href="/configuracoes"
      className="mb-6 inline-flex animate-rise items-center gap-2 text-sm text-muted transition-colors hover:text-fg"
    >
      <ArrowLeft aria-hidden className="h-4 w-4" /> Configurações
    </Link>
  );

  if (!isSupabaseConfigured()) {
    return (
      <>
        {back}
        <PageHeader title="Captura automática" subtitle={SUBTITLE} badge="Dados fictícios" />
        <Card className="animate-rise">
          <p className="text-sm text-muted">A captura automática não funciona em modo demonstração.</p>
        </Card>
      </>
    );
  }

  let loaded;
  try {
    const [data, accounts, cards] = await Promise.all([getCaptureData(), listAccounts(), listCards()]);
    loaded = { data, accounts, cards };
  } catch (error) {
    if (error instanceof MigrationRequiredError) {
      return (
        <>
          {back}
          <PageHeader title="Captura automática" subtitle={SUBTITLE} />
          <MigrationNotice file="0007_capture.sql" />
        </>
      );
    }
    throw error;
  }

  const { data, accounts, cards } = loaded;
  const targets: TargetOption[] = [
    ...accounts
      .filter((a) => !a.archived)
      .map((a) => ({
        value: `account:${a.id}`,
        label: a.institution ? `${a.name} · ${a.institution}` : a.name,
        kind: "account" as const,
      })),
    ...cards
      .filter((c) => !c.archived)
      .map((c) => ({ value: `card:${c.id}`, label: `Cartão ${c.name}`, kind: "card" as const })),
  ];

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "seu-dominio";
  const protocol = h.get("x-forwarded-proto") ?? "https";
  const endpoint = `${protocol}://${host}/api/capture`;
  const isLocal = /localhost|127\.0\.0\.1/.test(host);

  const sharedSteps = (
    <>
      Em <strong className="text-fg">Atalhos → Automação → +</strong>, escolha o gatilho indicado e marque{" "}
      <strong className="text-fg">Executar Imediatamente</strong>.
    </>
  );
  const requestStep = (body: string) => (
    <>
      Adicione <strong className="text-fg">Obter Conteúdo de URL</strong> com o endereço acima, método{" "}
      <strong className="text-fg">POST</strong>, cabeçalho <code className="text-fg">Authorization</code> ={" "}
      <code className="text-fg">Bearer seu_token</code> e corpo <strong className="text-fg">JSON</strong>: {body}
    </>
  );

  return (
    <>
      {back}
      <PageHeader title="Captura automática" subtitle={SUBTITLE} />

      <div className="space-y-3">
        <PendingPanel events={data.pending} targets={targets} />
        <PluggyPanel configured={pluggyEnv() !== null} links={data.links} targets={targets} />
        <TokensPanel tokens={data.tokens} />

        <Card className="animate-rise">
          <CardTitle>Configurar no iPhone</CardTitle>
          <p className="mt-3 text-sm text-muted">
            Atalhos é um app da própria Apple, sem custo. As automações são criadas uma vez, à mão, porque o
            iOS não permite instalá-las por um link. Elas enviam para este endereço:
          </p>
          <div className="mt-3">
            <CopyField value={endpoint} label="endereço" />
          </div>
          {isLocal && (
            <p className="mt-2 text-xs text-fg">
              Este é um endereço local: o iPhone só consegue enviar depois que o WALLET OS estiver publicado na internet.
            </p>
          )}

          <h3 className="mt-6 text-sm font-medium">Compras com Apple Pay</h3>
          <p className="mt-1 text-xs text-muted">Registra na hora o estabelecimento e o valor. Depende de o cartão informar a compra à Carteira.</p>
          <Steps
            items={[
              <>{sharedSteps} Gatilho: <strong className="text-fg">Carteira</strong> (Transação), escolhendo o cartão.</>,
              requestStep("source = apple_pay; merchant = Comerciante; amount = Valor; card = Nome do cartão."),
              <>Opcional: adicione <strong className="text-fg">Obter Localização Atual</strong> e envie em <code className="text-fg">location</code>. Registra onde o iPhone estava, não o endereço da loja.</>,
            ]}
          />

          <h3 className="mt-6 text-sm font-medium">Avisos do app do banco (iOS 27)</h3>
          <p className="mt-1 text-xs text-muted">
            Experimental: não confirmamos em aparelho real se o iOS entrega o texto da notificação ao atalho.
            Teste com um Pix pequeno. Códigos e senhas são sempre descartados.
          </p>
          <Steps
            items={[
              <>{sharedSteps} Gatilho: <strong className="text-fg">Notificação</strong>, escolhendo o app do banco.</>,
              requestStep("source = notification; text = Entrada do Atalho; card = nome da conta ou do cartão."),
              <>Faça uma compra de teste e confira em Transações. Se aparecer em “Para revisar”, ou não aparecer, conte com o Open Finance para esse banco.</>,
            ]}
          />

          <h3 className="mt-6 text-sm font-medium">Abrir como app, sem App Store</h3>
          <Steps
            items={[
              <>Abra o WALLET OS no <strong className="text-fg">Safari</strong> do iPhone.</>,
              <>Toque em <strong className="text-fg">Compartilhar → Adicionar à Tela de Início</strong>.</>,
            ]}
          />
        </Card>
      </div>
    </>
  );
}
