import { headers } from "next/headers";
import { MigrationNotice } from "@/components/migration-notice";
import { Card, CardTitle } from "@/components/ui/card";
import { listAccounts } from "@/features/accounts/queries";
import { ConnectionsPanel, CopyField, TokensPanel } from "@/features/agent/components/connections-panel";
import { pluggyEnv } from "@/features/agent/providers/pluggy";
import { listConnections, listTokens } from "@/features/agent/queries";
import { listCards } from "@/features/cards/queries";
import { MigrationRequiredError } from "@/lib/action-result";
import { isSupabaseConfigured } from "@/lib/env";
import { toTargets } from "../targets";

export const dynamic = "force-dynamic";

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

export default async function ConnectionsPage() {
  if (!isSupabaseConfigured()) return null;

  let loaded;
  try {
    const [connectionData, tokens, accounts, cards] = await Promise.all([
      listConnections(),
      listTokens(),
      listAccounts(),
      listCards(),
    ]);
    loaded = { ...connectionData, tokens, accounts, cards };
  } catch (error) {
    if (error instanceof MigrationRequiredError) return <MigrationNotice file="0010_agent_connections.sql" />;
    throw error;
  }

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "seu-dominio";
  const protocol = h.get("x-forwarded-proto") ?? "https";
  const endpoint = `${protocol}://${host}/api/capture`;
  const isLocal = /localhost|127\.0\.0\.1/.test(host);

  const shared = (
    <>
      Em <strong className="text-fg">Atalhos → Automação → +</strong>, escolha o gatilho indicado e marque{" "}
      <strong className="text-fg">Executar Imediatamente</strong>.
    </>
  );
  const request = (body: string) => (
    <>
      Adicione <strong className="text-fg">Obter Conteúdo de URL</strong> com o endereço acima, método{" "}
      <strong className="text-fg">POST</strong>, cabeçalho <code className="text-fg">Authorization</code> ={" "}
      <code className="text-fg">Bearer seu_token</code> e corpo <strong className="text-fg">JSON</strong>: {body}
    </>
  );

  return (
    <div className="space-y-3">
      <ConnectionsPanel
        configured={pluggyEnv() !== null}
        connections={loaded.connections}
        links={loaded.links}
        targets={toTargets(loaded.accounts, loaded.cards)}
      />
      <TokensPanel tokens={loaded.tokens} />

      <Card className="animate-rise">
        <CardTitle>Configurar no iPhone</CardTitle>
        <p className="mt-3 text-sm text-muted">
          Atalhos é um app da própria Apple, sem custo. As automações são criadas uma vez, à mão, porque o iOS não
          permite instalá-las por um link. Elas enviam para este endereço:
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
        <p className="mt-1 text-xs text-muted">
          Registra na hora o estabelecimento e o valor. Depende de o cartão informar a compra à Carteira.
        </p>
        <Steps
          items={[
            <>{shared} Gatilho: <strong className="text-fg">Carteira</strong> (Transação), escolhendo o cartão.</>,
            request("source = apple_pay; merchant = Comerciante; amount = Valor; card = Nome do cartão."),
            <>
              Opcional: adicione <strong className="text-fg">Obter Localização Atual</strong> e envie em{" "}
              <code className="text-fg">location</code>. Registra onde o iPhone estava, não o endereço da loja.
            </>,
          ]}
        />

        <h3 className="mt-6 text-sm font-medium">Avisos do app do banco (iOS 27)</h3>
        <p className="mt-1 text-xs text-muted">
          Experimental: não confirmamos em aparelho real se o iOS entrega o texto da notificação ao atalho. Teste com
          um Pix pequeno. Códigos e senhas são sempre descartados.
        </p>
        <Steps
          items={[
            <>{shared} Gatilho: <strong className="text-fg">Notificação</strong>, escolhendo o app do banco.</>,
            request("source = notification; text = Entrada do Atalho; card = nome da conta ou do cartão."),
            <>
              Faça uma compra de teste e confira em Transações. Se aparecer em “Revisão”, ou não aparecer, conte com o
              Open Finance para esse banco.
            </>,
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
  );
}
