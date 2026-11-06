# WALLET OS

Sistema operacional pessoal: **Finance Intelligence**, **Chief of Staff** e **AI Command Center**.
Next.js (App Router) · React · TypeScript · Tailwind CSS · Supabase (PostgreSQL + Auth).

> Status: **Fase 1 concluída. Fase 2 em andamento** (ver [Progresso da Fase 2](#progresso-da-fase-2)).
> Os módulos ainda não entregues aparecem na navegação com a fase em que serão entregues.

## Progresso da Fase 2

| # | Módulo | Estado |
|---|---|---|
| 1 | Contas bancárias | Implementado; **aguardando validação no Supabase real** (passos abaixo) |
| 2 | Categorias | Não iniciado |
| 3 | Transações e transferências | Não iniciado |
| 4 | Cartões de crédito | Não iniciado |
| 5 | Faturas e parcelamentos | Não iniciado |
| 6 | Importação OFX e CSV | Não iniciado |
| 7 | Relatórios e PDF | Não iniciado |
| 8 | Dashboard financeiro | Não iniciado |

### Validar o Módulo 1 no ambiente real

1. No Supabase, abra *SQL Editor → New query*, cole o conteúdo de
   `supabase/migrations/0002_accounts.sql` e execute. A migration preserva os saldos atuais.
   Se houver transação apontando para a conta de outro usuário, ela aborta sem alterar nada.
2. Rode `npm run dev`, entre e abra **Financeiro**.
3. Crie uma conta com saldo inicial, edite o saldo inicial, arquive, reative e exclua. Depois
   crie outra conta e confira se o **Saldo total** do Overview acompanha o valor.

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
   **Financeiro**. Até os próximos módulos da Fase 2, cartões, transações e
   faturas ainda são inseridos no *Table Editor* (`credit_cards`, `transactions`
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
      financeiro/         contas bancárias (lista e detalhe)
      configuracoes/      conta e integrações
      [section]/          demais módulos (placeholders com a fase planejada)
    manifest.ts, icon.svg PWA (completa na Fase 5)
  components/             nav, gráfico SVG e ui/ (botão, campos, modal, toast, skeleton...)
  features/               um domínio por pasta: schema, queries, actions, components
  lib/                    env, supabase, auth, money, audit, overview, demo-data
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
- FK composta `(account_id, user_id)` em `transactions`: uma transação não pode apontar para a conta de outro usuário, o que o RLS sozinho não impede. As demais referências recebem a mesma proteção nos módulos correspondentes.
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
| 3 | Projeto no Google Cloud (OAuth, Gmail API, Calendar API) |
| 4 | Chave de API de um provedor de LLM |
| 5 | Upstash Redis (rate limit), Sentry (erros) |

## Decisão de projeto: sem Open Finance

Não há integração bancária automática. Contas e cartões são cadastrados manualmente e as transações
entram por lançamento manual ou importação de extrato (OFX/CSV). A tabela `import_batches` registra
cada importação; `transactions.dedupe_hash` impede duplicidade ao reimportar o mesmo arquivo.
