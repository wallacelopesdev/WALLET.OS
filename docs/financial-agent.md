# WALLET OS Financial Agent: arquitetura

O agente mantém a vida financeira atualizada a partir de fontes autorizadas: recebe movimentações,
classifica, concilia, alerta e responde perguntas. **Ele nunca movimenta dinheiro.**

## Fluxo

```
Fontes -> Normalização -> Pipeline -> Banco (função atômica) -> Efeitos
Pluggy, Atalhos,          classificar,                          alertas, auditoria,
OFX, CSV                  deduplicar, conciliar, decidir        indicadores
```

- `capture_events` é a fila e o histórico: cada evento recebido é registrado uma vez.
- A classificação, a deduplicação, a decisão e as automações ficam em funções SQL `security definer`, que
  conferem o dono. Ficam no banco porque o agendador e os Atalhos não têm sessão de usuário.
- O TypeScript (`src/features/agent/`) cuida do que vem antes: traduzir provedores e arquivos em eventos.
- Nenhuma operação usa a service role.

## Matriz de permissões

| O agente faz sozinho | Exige sua decisão | O agente nunca faz |
|---|---|---|
| Ler fontes autorizadas | Duplicidade provável sem prova | Pix ou transferência real |
| Registrar lançamento confiável | Possível transferência entre suas contas | Pagar boleto ou fatura no banco |
| Categorizar com alta confiança | Pagamento de fatura sem correspondência exata | Compras, contratações, investimentos |
| Reconhecer duplicidade exata | Classificação de baixa confiança | Guardar senha, CVV ou número do cartão |
| Criar alertas e resumos | Destino não identificado | Scraping de internet banking |

Quando você corrige uma categoria, ela vira regra e nunca é alterada pelo agente.

## Classificação e deduplicação

A categoria vem, nesta ordem, de: regra sua, memória da mesma descrição, dicionário de palavras-chave.
Abaixo da confiança mínima, fica como sugestão. O que você confirmou nunca é alterado.

A duplicidade é decidida por identificador externo, depois por hash, depois por valor, data e destino
**com** semelhança de descrição. Sem semelhança, o evento vai para revisão como possível duplicidade.

Transferência entre contas próprias sempre passa pela sua revisão: sem `paymentData`, não há prova de que
os dois lados são seus. Um boleto só fica pago quando uma transação confirmada corresponde a ele, de forma
inequívoca.

## Rotinas

| Rotina | Quando | O que faz |
|---|---|---|
| `/api/cron/agent` | Uma vez por dia (`vercel.json`) | Sincroniza e roda as automações |
| `/api/webhooks/pluggy` | Quando a Pluggy avisar (opcional) | Sincroniza depois de responder |
| Botão **Sincronizar agora** | Quando você pedir | Sincroniza com a sua sessão |

`agent_runs` impede duas sincronizações simultâneas do mesmo usuário e guarda o resultado de cada uma.
Uma conexão com falha não interrompe as outras, e tenta de novo com espera crescente. Uma conta só avança
a janela de leitura se tudo nela deu certo; reprocessar é seguro porque cada evento é idempotente.

## Conversa

Perguntas conhecidas são respondidas por um interpretador local, sem enviar dados para fora, sempre com
período e origem. Com `ANTHROPIC_API_KEY`, perguntas que ele não entende vão para a Claude API, que recebe a
pergunta e os resultados de uma única ferramenta de consulta. Descrições de lançamentos são tratadas como dados, nunca
como instruções. O modelo não tem como escrever nada.

## Limites das fontes

| Fonte | Traz | Não traz |
|---|---|---|
| **Meu Pluggy** (Open Finance) | Contas, cartões, parcelas, `operationType` | Atualização em tempo real (24h), boletos pendentes (sem DDA), estabelecimento e categoria (plano Pro), provavelmente pagador e recebedor (`paymentData` é de conectores diretos) |
| **Atalhos: Apple Pay** | Estabelecimento, valor, cartão, na hora | Pix, cartão físico; depende de o cartão informar a Carteira |
| **Atalhos: notificação** (iOS 27) | O texto do aviso, se o iOS o entregar | Não confirmado em aparelho real |
| **OFX e CSV** | O que o banco exportar, até 4 MB e 5.000 linhas | Automatismo: depende de você enviar o arquivo |

A autorização do Meu Pluggy dura 1 ano e é renovada no painel da Pluggy. O plano gratuito cobre até 5
conexões, somente contas suas, e não permite conectar bancos de dentro do WALLET OS.

## Credenciais

Nenhum token de banco é guardado. As credenciais da aplicação (`PLUGGY_CLIENT_ID`,
`PLUGGY_CLIENT_SECRET`) ficam só em variáveis do servidor. Os tokens dos Atalhos ficam só como hash.
Outro provedor que exija token por conexão deve criptografá-lo com `TOKEN_ENCRYPTION_KEY`.

## Trocar de provedor

O pipeline só conhece a interface `OpenFinanceProvider`. Para adicionar outro provedor, como a Belvo,
implemente essa interface e devolva eventos normalizados. Nada no pipeline muda.

## Testes

```bash
npm test           # regras, migrations e RLS em Postgres em memória
npm run test:e2e   # Next e Chrome reais, API do Supabase e da Pluggy simuladas
npm run lint
npm run typecheck
npm run build
```

Os testes simulam as APIs: não substituem a validação com o Supabase, a Pluggy, a Claude API e um iPhone reais.
