# WALLET OS

Sistema operacional pessoal: **Finance Intelligence**, **Chief of Staff** e **AI Command Center**.
Next.js (App Router) · React · TypeScript · Tailwind CSS · Supabase (PostgreSQL + Auth).

> Status: **Fase 1 concluída. Fase 2 em andamento** (ver [Progresso da Fase 2](#progresso-da-fase-2)).
> Os módulos ainda não entregues aparecem na navegação com a fase em que serão entregues.

## Progresso da Fase 2

| # | Módulo | Estado |
|---|---|---|
| 1 | Contas bancárias | Implementado; migration aplicada; **aguardando teste de tela no Supabase real** |
| 2 | Categorias | Implementado; migration aplicada; **aguardando teste de tela no Supabase real** |
| 3 | Transações e transferências | Implementado; migrations aplicadas; **aguardando teste de tela no Supabase real** |
| 4 | Cartões de crédito | Implementado; **aguardando migration `0006` e teste no Supabase real** |
| 5 | Faturas e parcelamentos | Implementado; **aguardando migration `0006` e teste no Supabase real** |
| + | Captura automática (iPhone e Open Finance) | Implementado; **aguardando migration `0007`, publicação e credenciais** |
| 6 | Importação OFX e CSV | Não iniciado |
| 7 | Relatórios e PDF | Não iniciado |
| 8 | Dashboard financeiro | Não iniciado |

### Validar os Módulos 1 a 5 no ambiente real

1. No Supabase, abra *SQL Editor → New query* e execute **um arquivo por vez, nesta ordem**,
   conferindo o sucesso de cada um antes do próximo (até a `0005` já foi aplicada):
   `0006_cards.sql` e `0007_capture.sql`.
   Nenhuma apaga dados nem altera saldos. Se uma falhar, ela não altera nada.
2. Rode `npm run dev` e entre.
3. **Contas** (*Financeiro*): crie, edite o saldo inicial, arquive, reative e exclua uma conta.
4. **Categorias** (*Financeiro → Categorias*): crie, edite, arquive, reative e exclua uma categoria.
5. **Transações**: registre uma despesa e uma receita, confira o saldo da conta, edite e exclua.
   Com duas contas, faça uma transferência e confira que o total não muda e que o Overview
   não a conta como receita nem despesa. Teste a busca e os filtros.
6. **Cartões**: cadastre um cartão com os dias reais de fechamento e vencimento. Registre uma compra
   parcelada e confira as faturas com a do seu banco. Pague uma fatura e confira que o saldo cai,
   mas as despesas do mês não aumentam.

## Captura automática

O iOS isola os apps: nenhum app instalado pelo Safari consegue ler os dados dos apps de banco. Por
isso a captura combina duas fontes, e o sistema reconhece quando as duas trazem a mesma compra.

| Fonte | O que traz | Quando | Limitação |
|---|---|---|---|
| **Meu Pluggy** (Open Finance) | Contas e cartões dos bancos conectados | Até 24h depois | Até 5 conexões grátis, só contas suas |
| **Atalhos: Apple Pay** | Estabelecimento, valor e cartão | Na hora | Só compras por aproximação com o iPhone |
| **Atalhos: notificação do banco** (iOS 27) | Depende do texto do aviso | Na hora | Experimental, não confirmado em aparelho real |

O que o sistema não consegue decidir fica em *Configurações → Captura automática → Para revisar* e
só entra nos saldos depois da sua escolha, como pagamentos de fatura e possíveis transferências
entre suas contas. A categoria é repetida a partir da última vez em que a mesma descrição apareceu.

### Publicar (necessário para o iPhone e para a sincronização diária)

O iPhone não alcança o seu computador. Publique na Vercel seguindo a seção [Deploy](#deploy-vercel).

### Conectar os bancos (Meu Pluggy)

1. Crie a conta em [meu.pluggy.ai](https://meu.pluggy.ai) e conecte cada banco. A autorização acontece
   no próprio banco: sua senha não passa pelo WALLET OS.
2. Em [dashboard.pluggy.ai](https://dashboard.pluggy.ai), crie uma aplicação, ative o conector
   **MeuPluggy**, vincule cada banco e copie o **Client ID** e o **Client Secret**.
3. Copie o **ID de cada conexão** no Meu Pluggy.
4. Preencha, no `.env.local` e nas variáveis da Vercel: `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET` e
   `PLUGGY_ITEM_IDS` (IDs separados por vírgula).
5. Em *Configurações → Captura automática*, clique em **Ver contas do banco** e ligue cada uma à
   conta ou ao cartão correspondente. Só entra o que acontecer depois de ligar: o histórico anterior
   já está no saldo inicial que você informou.
6. Para a sincronização diária, crie um token na mesma tela e cadastre na Vercel `WALLET_SYNC_TOKEN`
   (o token) e `CRON_SECRET` (um texto aleatório longo). O agendamento está em `vercel.json`, uma vez
   por dia. Sem isso, use o botão **Sincronizar agora**.

No plano gratuito, a Pluggy não fornece o nome do estabelecimento nem categorias enriquecidas, que
exigem o plano Pro: a descrição é a que o banco envia. Compras parceladas chegam como uma linha por
parcela, e a fatura é calculada pela regra do seu cartão, podendo diferir da fatura do banco em compras
perto do fechamento.

### Configurar o iPhone (Atalhos)

Os passos estão em *Configurações → Captura automática*, com o endereço pronto para copiar. As
automações são criadas à mão, uma vez, porque o iOS não permite instalá-las por um link. Para abrir o
WALLET OS como um app, sem App Store: Safari → Compartilhar → **Adicionar à Tela de Início**.

### Decisões dos Módulos 2 a 5

- **Categorias existentes:** as originais continuam, inclusive Mercado, Delivery, Jogos e Bobeiras.
  As que ainda têm o nome padrão passam a seguir a lista nova (`Uber e transporte` → `Transporte`,
  `Compras pessoais` → `Compras`, `Contas fixas` → `Contas`, `Outros` → `Outros gastos`).
  Novos usuários recebem apenas a lista nova.
- **Status do lançamento:** não existe. Todo lançamento já está efetivado e conta no saldo, por
  isso a data da movimentação não pode ser futura. A competência pode.
- **Método "Crédito" em Transações:** debita a conta na hora. Para compras no cartão, use o botão **Nova compra** do cartão.
- **Transferências:** são um par de lançamentos que o banco mantém íntegro no fim de cada transação.
- **Competência da fatura:** compra antes do dia de fechamento entra na fatura daquele mês; no dia ou depois, na seguinte. A fatura leva o nome do mês em que fecha. Alguns bancos tratam o dia do fechamento de outra forma.
- **Limite usado:** tudo que falta pagar, inclusive parcelas futuras. Uma compra acima do limite é registrada com aviso, pois ela já aconteceu.
- **Status da fatura:** aberta e fechada dependem da data de fechamento, atrasada do vencimento, paga do valor quitado. Só o valor é gravado; o status é calculado na leitura.
- **Mudar fechamento ou vencimento:** vale para as faturas novas. As existentes não mudam.
- **Editar compra:** descrição e categoria. Para mudar valor ou data, exclua e registre de novo, o que é recusado se alguma fatura envolvida já recebeu pagamento.

## Requisitos

- Node.js 20 ou superior (você já tem).
- Uma conta gratuita no [Supabase](https://supabase.com). Não precisa instalar PostgreSQL nem Docker.

## Rodar em modo demonstração (sem Supabase)

```bash
npm install
npm run dev
```

Abra http://localhost:3000. Sem `.env.local`, o app roda em **modo demonstração**: dados fictícios,
identificados com banner e selo, e nada é salvo. Em produção, sem credenciais, o app responde 503
(nunca expõe a demonstração).

## Configurar com dados reais

1. **Criar o projeto** no Supabase (região `South America (São Paulo)` é a mais próxima).
2. **Desativar cadastros públicos**: *Authentication → Sign In / Providers → desmarque "Allow new users to sign up"*.
   O sistema é de uso pessoal; não existe tela de cadastro.
3. **Criar seu usuário**: *Authentication → Users → Add user → Create new user* (e-mail + senha forte).
   Ative MFA depois, em *Authentication → Multi-Factor*.
4. **Aplicar o banco**: *SQL Editor → New query*, cole e execute cada arquivo de
   `supabase/migrations/`, em ordem numérica e um por vez. A `0001_init.sql` cria as tabelas,
   índices, RLS, o perfil e as 13 categorias padrão para cada novo usuário.
   > Crie o usuário (passo 3) **depois** de aplicar a migration, para o perfil e as categorias
   > serem criados automaticamente pelo gatilho. Se criou antes, apague o usuário e crie de novo.
5. **Variáveis de ambiente**: copie `.env.example` para `.env.local` e preencha
   `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   (*Project Settings → API Keys*). Use a chave `anon`/publishable; nunca use
   `service_role` nessa variável. Reinicie o `npm run dev`.
6. **Adicionar seus dados**: entre com o usuário criado. A migration prepara o
   banco, mas não inventa saldos nem transações. As contas são cadastradas em
   **Financeiro** e os lançamentos em **Transações**. Até os próximos módulos da
   Fase 2, cartões e faturas ainda são inseridos no *Table Editor* (`credit_cards`
   e `card_invoices`), com o UUID do seu usuário em `user_id`. O dashboard lê
   esses dados reais e permanece zerado quando as tabelas estão vazias.

Sem nenhuma variável Supabase, o modo demonstração continua disponível somente
em desenvolvimento. Se uma variável estiver preenchida mas a URL ou a chave for
inválida/incompleta, o app retorna erro 503 em vez de mostrar dados fictícios.

## Estrutura

```
src/
  app/
    login/                tela de login + server actions (signIn, signOut)
    (app)/                área autenticada (sidebar no desktop, tab bar no iPhone)
      overview/           dashboard
      financeiro/         contas bancárias (lista e detalhe) e categorias
      transacoes/         receitas, despesas e transferências
      cartoes/            cartões, faturas, compras e parcelas
      configuracoes/      conta, integrações e captura automática
    api/capture/          recebe os eventos dos Atalhos (autenticação por token)
    api/cron/pluggy/      sincronização diária com o Open Finance
      [section]/          demais módulos (placeholders com a fase planejada)
    manifest.ts, icon.svg PWA (completa na Fase 5)
  components/             nav, gráfico SVG e ui/ (botão, campos, modal, toast, skeleton...)
  features/               um domínio por pasta: schema, queries, actions, components
  lib/                    env, supabase, auth, money, dates, audit, overview, demo-data
  middleware.ts           renovação de sessão e proteção de rotas
supabase/migrations/      SQL versionado com RLS
tests/                    unit/ (regras) e db/ (migrations, saldo e RLS em Postgres real)
```

## Testes

```bash
npm test            # vitest: regras financeiras, validações, migrations e RLS
npm run typecheck
npm run build
```

Os testes de banco rodam em Postgres em memória (PGlite), sem Docker e sem acessar o Supabase.
Eles aplicam os arquivos reais de `supabase/migrations/` e executam como os roles `anon` e
`authenticated`, simulando dois usuários. Não substituem a validação no Supabase real.

## Como o saldo funciona

O banco mantém a invariante `balance_cents = opening_balance_cents + soma(transactions.amount_cents)`
por meio de triggers. A aplicação nunca grava o saldo: o cliente não tem permissão de escrita em
`balance_cents`, e escritas diretas, mesmo no *Table Editor*, são ignoradas. Para corrigir um
saldo, ajuste o saldo inicial da conta ou lance uma movimentação.

## Segurança

- Sessão validada no servidor a cada requisição (`auth.getUser()`), cookies gerenciados por `@supabase/ssr`.
- RLS em todas as tabelas: `user_id = auth.uid()`.
- FKs compostas com `user_id` em contas, categorias, cartões e faturas: uma transação não pode apontar para dados de outro usuário, o que o RLS sozinho não impede. Lotes de importação recebem a mesma proteção no módulo correspondente.
- Faturas e parcelas só mudam por funções do banco, que conferem o dono; o cliente não escreve nessas tabelas.
- Captura: cada iPhone usa um token revogável, guardado só como hash. O endpoint não usa a service role, aceita no máximo 8 KB e não devolve dados. O texto bruto das mensagens não é guardado, e mensagens com código ou senha são descartadas.
- Credenciais da Pluggy só no servidor. Nenhuma senha de banco passa pelo sistema. Nunca coloque valores reais no `.env.example`: este repositório é público.
- `audit_logs` é append-only para o cliente; login e logout são registrados.
- Tokens OAuth ficam em colunas criptografadas e **não são legíveis pelo cliente** (GRANT por coluna).
- Cartões guardam apenas os 4 últimos dígitos (constraint no banco). Nunca senha, CVV ou número completo.
- Ações do agente originadas de conteúdo não confiável (e-mails) exigem confirmação (constraint em `agent_actions`).
- Cabeçalhos de segurança (HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy).
- Nenhuma credencial no frontend. `SUPABASE_SERVICE_ROLE_KEY` nunca recebe o prefixo `NEXT_PUBLIC_`.

## Deploy (Vercel)

1. Suba o repositório ao GitHub (o `.gitignore` já exclui `.env*`).
2. Importe na Vercel e cadastre as variáveis do `.env.example` em *Settings → Environment Variables*.
3. No Supabase, em *Authentication → URL Configuration*, informe a URL de produção.

## Roadmap

| Fase | Conteúdo |
|---|---|
| 1 | Estrutura visual, autenticação, navegação, banco, Overview |
| 2 | Finanças sem Open Finance: lançamento manual, importação OFX/CSV, categorias, cartões, relatórios em PDF (**atual**) |
| 3 | Tarefas, Gmail e Google Calendar (OAuth 2.0), resumo diário |
| 4 | AI Command Center: chat, ferramentas por módulo, confirmações, histórico |
| 5 | PWA completa (ícones PNG, service worker), rate limiting, testes, produção |

## Credenciais externas por fase

| Fase | Necessário |
|---|---|
| 1 | Supabase |
| 2 (captura, opcional) | Meu Pluggy e publicação na Vercel |
| 3 | Projeto no Google Cloud (OAuth, Gmail API, Calendar API) |
| 4 | Chave de API de um provedor de LLM |
| 5 | Upstash Redis (rate limit), Sentry (erros) |

## Decisão de projeto: Open Finance opcional

Esta decisão mudou durante a Fase 2: a integração bancária agora existe, pelo Meu Pluggy, e é opcional.
Contas e cartões continuam sendo cadastrados no WALLET OS, e as transações podem entrar por lançamento
manual, captura automática ou, no próximo módulo, importação de extrato (OFX/CSV). A tabela
`import_batches` registrará cada importação; `transactions.dedupe_hash` impede duplicidade.
