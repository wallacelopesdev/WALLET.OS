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
- Regras puras em TypeScript (`src/features/agent/`), testáveis sem banco.
- A gravação e a decisão final ficam em funções SQL `security definer`, que conferem o dono.
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

## Limites das fontes

| Fonte | Traz | Não traz |
|---|---|---|
| **Meu Pluggy** (Open Finance) | Contas, cartões, parcelas, `operationType` | Atualização em tempo real (24h), boletos pendentes (sem DDA), estabelecimento e categoria (plano Pro), provavelmente pagador e recebedor (`paymentData` é de conectores diretos) |
| **Atalhos: Apple Pay** | Estabelecimento, valor, cartão, na hora | Pix, cartão físico; depende de o cartão informar a Carteira |
| **Atalhos: notificação** (iOS 27) | O texto do aviso, se o iOS o entregar | Não confirmado em aparelho real |
| **OFX e CSV** | O que o banco exportar | Automatismo: depende de você enviar o arquivo |

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

Os testes simulam a API: não substituem a validação com o Supabase, a Pluggy e um iPhone reais.
