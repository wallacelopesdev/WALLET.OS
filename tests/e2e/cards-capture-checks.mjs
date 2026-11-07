// Checagens E2E de Cartões, Faturas e Captura automática.
import http from "node:http";

const BASE = "http://127.0.0.1:3100";

function startFakePluggy(state) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let raw = "";
    for await (const c of req) raw += c;
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/auth") {
      const body = JSON.parse(raw);
      if (body.clientId !== "cid" || body.clientSecret !== "SEGREDO_PLUGGY_E2E") return send(401, {});
      return send(200, { apiKey: "chave-api" });
    }
    if (req.headers["x-api-key"] !== "chave-api") return send(403, {});
    if (/^\/items\//.test(url.pathname)) return send(200, { status: "UPDATED", connector: { name: "Itaú" }, consentExpiresAt: "2027-11-01T00:00:00.000Z" });
    if (url.pathname === "/accounts") return send(200, { page: 1, total: 2, totalPages: 1, results: state.accounts });
    if (url.pathname === "/v2/transactions") {
      state.calls.push(url.search);
      const all = state.transactions[url.searchParams.get("accountId")] ?? [];
      const after = Number(url.searchParams.get("after") ?? 0);
      const page = all.slice(after, after + 2);
      const next = after + 2 < all.length ? `?accountId=${url.searchParams.get("accountId")}&after=${after + 2}` : null;
      return send(200, { results: page, next });
    }
    return send(404, {});
  });
  return new Promise((r) => server.listen(54400, "127.0.0.1", () => r(server)));
}

export async function runA(h) {
  const { check, goto, see, notSee, click, setVal, evalJs, waitFor, shot, sleep, db, scalar, viewport, hasText, USERS } = h;
  await viewport(1280, 860, false);

  const scope = `(document.querySelector('dialog[open]') ?? document)`;
  const clickContains = async (text) => {
    await waitFor(`[...${scope}.querySelectorAll('button,a')].some(e=>e.innerText.includes(${JSON.stringify(text)}))`, "contém " + text);
    await evalJs(`[...${scope}.querySelectorAll('button,a')].find(e=>e.innerText.includes(${JSON.stringify(text)})).click()`);
  };
  const modal = (sel) => waitFor(`!!document.querySelector('dialog[open] ${sel}')`, "modal " + sel);
  const modalClosed = () => waitFor(`!document.querySelector('dialog[open]')`, "modal fechado");
  const balance = async (name) => Number(await scalar("select balance_cents from public.bank_accounts where name=$1", [name]));
  const count = async (sql, p) => Number(await scalar(sql, p));
  const today = await evalJs(`new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date())`);
  const noOverflow = async (label) => {
    const over = await evalJs(`document.documentElement.scrollWidth - window.innerWidth`);
    if (over > 0) throw new Error(`overflow ${label}: ${over}`);
  };

  // ------------------------------------------------------------ Cartões
  await check("[M4] estado vazio e cadastro valida, sem aceitar número completo", async () => {
    await goto("/cartoes");
    await see("Nenhum cartão cadastrado");
    await click("Cadastrar primeiro cartão");
    await modal("input[name=name]");
    await setVal("input[name=last4]", "4111111111111111");
    await click("Cadastrar cartão");
    await see("Nunca o número completo");
    await see("Informe um nome para o cartão.");
    await see("Informe um dia entre 1 e 31.");
    if ((await evalJs(`document.querySelector('input[name=last4]').value`)) !== "4111111111111111") throw new Error("campo apagado");
    await shot("30-form-cartao-desktop");
    if ((await count("select count(*) from public.credit_cards")) !== 0) throw new Error("gravou");
  });

  await check("[M4] cadastrar cartão grava limite em centavos e aparece sem recarregar", async () => {
    await setVal("input[name=name]", "Roxinho");
    await setVal("input[name=institution]", "Nubank");
    await setVal("#card-limit", "5.000,00");
    await setVal("input[name=closingDay]", "28");
    await setVal("input[name=dueDay]", "5");
    await setVal("input[name=last4]", "1234");
    await click("Cadastrar cartão");
    await waitFor(`!document.querySelector('dialog[open]')`, "fechou");
    await see("Roxinho");
    const row = (await db.query("select limit_cents, last4, closing_day, due_day from public.credit_cards where name='Roxinho'")).rows[0];
    if (Number(row.limit_cents) !== 500000 || row.last4 !== "1234" || row.closing_day !== 28 || row.due_day !== 5) throw new Error("linha");
    await see("R$ 5.000,00");
  });

  const cardId = (await db.query("select id from public.credit_cards where name='Roxinho'")).rows[0]?.id;
  const principalBefore = await balance("Principal");

  await check("[M5] compra 3x: 3 faturas, soma exata, sem mexer no saldo, consome o limite", async () => {
    await goto(`/cartoes/${cardId}`);
    await see("Nenhuma fatura ainda");
    await see("Excluir");
    await click("Nova compra");
    await modal("input[name=description]");
    await setVal("#purchase-amount", "100,00");
    await setVal("input[name=description]", "Tênis");
    await setVal("select[name=installments]", "3");
    const cat = (await db.query("select id from public.transaction_categories where slug='compras' and user_id=$1", [USERS["a@teste.dev"]])).rows[0].id;
    await setVal("select[name=categoryId]", cat);
    await shot("31-form-compra-desktop");
    await click("Registrar compra");
    await see("Compra registrada em 3x.");
    await modalClosed();
    const rows = (await db.query("select amount_cents, installment_number from public.transactions where description='Tênis' order by installment_number")).rows;
    if (rows.map((r) => Number(r.amount_cents)).join() !== "-3334,-3333,-3333") throw new Error(JSON.stringify(rows.map((r) => Number(r.amount_cents))));
    if ((await count("select count(*) from public.card_invoices where card_id=$1", [cardId])) !== 3) throw new Error("faturas");
    if ((await balance("Principal")) !== principalBefore) throw new Error("mexeu no saldo");
    await see("R$ 4.900,00");
    await see("Fatura atual");
    await see("Próximas faturas");
    if (!(await notSee("Excluir"))) throw new Error("oferece excluir cartão com fatura");
    await shot("32-cartao-detalhe-desktop");
  });

  await check("[M5] clique duplo não duplica a compra", async () => {
    await click("Nova compra");
    await modal("input[name=description]");
    await setVal("#purchase-amount", "10,00");
    await setVal("input[name=description]", "Duplo cartão");
    await sleep(100);
    await evalJs(`(()=>{const f=document.querySelector('dialog[open] form');f.requestSubmit();f.requestSubmit();})()`);
    await modalClosed();
    await sleep(2000);
    if ((await count("select count(*) from public.transactions where description='Duplo cartão'")) !== 1) throw new Error("duplicou");
  });

  const invoiceId = (await db.query("select id from public.card_invoices where card_id=$1 order by reference_month limit 1", [cardId])).rows[0]?.id;

  await check("[M5] fatura mostra período, compras, parcela e status", async () => {
    await goto(`/cartoes/${cardId}/faturas/${invoiceId}`);
    await see("Fatura de");
    await see("Tênis");
    await see("Parcela 1/3");
    await see("Fechamento");
    await see("Vencimento");
    await see("R$ 43,34");
    await see("Aberta");
    await shot("33-fatura-desktop");
  });

  await check("[M5] pagamento acima do saldo é recusado e nada muda", async () => {
    await click("Pagar fatura");
    await modal("#pay-amount");
    if ((await evalJs(`document.querySelector('#pay-amount').value`)) !== "43,34") throw new Error("valor sugerido");
    await setVal("#pay-amount", "500,00");
    await click("Registrar pagamento");
    await see("Maior que o saldo em aberto.");
    if ((await balance("Principal")) !== principalBefore) throw new Error("debitou");
    await click("Cancelar");
    await modalClosed();
  });

  const pay = async (amount) => {
    await click("Pagar fatura");
    await modal("#pay-amount");
    const id = (await db.query("select id from public.bank_accounts where name='Principal'")).rows[0].id;
    await setVal("select[name=accountId]", id);
    await setVal("#pay-amount", amount);
    await click("Registrar pagamento");
    await modalClosed();
  };

  const expenseSum = () => count("select coalesce(sum(amount_cents),0) from public.transactions where kind='expense'");

  await check("[M5] pagamento parcial, depois total: debita, quita e não gera despesa nova", async () => {
    const expensesBefore = await expenseSum();
    await pay("10,00");
    await see("R$ 33,34");
    if ((await balance("Principal")) !== principalBefore - 1000) throw new Error("parcial");
    await waitFor(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Pagar fatura')`, "botão");
    await sleep(300);
    await pay("33,34");
    await see("Paga");
    if ((await balance("Principal")) !== principalBefore - 4334) throw new Error("total");
    if ((await expenseSum()) !== expensesBefore) throw new Error("gerou despesa duplicada");
    if (!(await notSee("Pagar fatura"))) throw new Error("ainda oferece pagar");
    await see("Pagamentos");
  });

  await check("[M5] overview: fatura paga não duplica despesa do mês", async () => {
    const monthExpense = Math.abs(await count(`select coalesce(sum(amount_cents),0) from public.transactions
      where amount_cents<0 and kind not in ('transfer','invoice_payment') and to_char(posted_at,'YYYY-MM')=$1`, [today.slice(0, 7)]));
    await goto("/overview");
    await see("Despesas do mês");
    const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(monthExpense / 100).replace(/ /g, " ");
    await see(brl);
  });

  await check("[M5] compra com fatura paga não pode ser excluída", async () => {
    await goto(`/cartoes/${cardId}/faturas/${invoiceId}`);
    await clickContains("Tênis");
    await modal("input[name=description]");
    await click("Excluir compra");
    await see("As 3 parcelas serão removidas");
    await sleep(400);
    await click("Excluir");
    await see("já recebeu pagamento");
    await modalClosed();
    if ((await count("select count(*) from public.transactions where description='Tênis'")) !== 3) throw new Error("excluiu");
  });

  await check("[M5] desfazer pagamento devolve o saldo e reabre a fatura", async () => {
    await goto(`/cartoes/${cardId}/faturas/${invoiceId}`);
    for (let i = 0; i < 2; i++) {
      await click("Desfazer");
      await see("O valor volta para a conta");
      await sleep(350);
      await click("Desfazer pagamento");
      await modalClosed();
      await sleep(1200);
    }
    if ((await balance("Principal")) !== principalBefore) throw new Error("saldo " + (await balance("Principal")));
    await see("Aberta");
  });

  await check("[M5] editar compra vale para todas as parcelas", async () => {
    await clickContains("Tênis");
    await modal("input[name=description]");
    await see("todas as 3 parcelas");
    await setVal("input[name=description]", "Tênis novo");
    await click("Salvar alterações");
    await modalClosed();
    await see("Tênis novo");
    if ((await count("select count(*) from public.transactions where description='Tênis novo'")) !== 3) throw new Error("não aplicou");
  });

  await check("[M5] transações mostram cartão e parcela; abrem sem formulário e apontam a fatura", async () => {
    await goto("/transacoes?q=novo");
    await see("Roxinho");
    await see("Parcela 1/3");
    if (await evalJs(hasText("Conta removida"))) throw new Error("rótulo errado");
    await clickContains("Tênis novo");
    await see("são editados na");
    if (await evalJs(`!!document.querySelector('dialog[open] input[name=description]')`)) throw new Error("abriu formulário");
    await click("Fechar");
    await modalClosed();
  });

  await check("[M5] excluir a compra pela lista remove parcelas e faturas vazias", async () => {
    const before = await count("select count(*) from public.card_invoices where card_id=$1", [cardId]);
    await clickContains("Tênis novo");
    await sleep(300);
    await click("Excluir");
    await see("As 3 parcelas desta compra");
    await sleep(400);
    await click("Excluir");
    await see("Compra excluída.");
    await modalClosed();
    if ((await count("select count(*) from public.transactions where description='Tênis novo'")) !== 0) throw new Error("restou");
    if ((await count("select count(*) from public.card_invoices where card_id=$1", [cardId])) >= before) throw new Error("faturas vazias");
  });

  await check("[M4] arquivar cartão bloqueia compras e tira da lista ativa", async () => {
    await goto(`/cartoes/${cardId}`);
    await click("Arquivar");
    await see("deixa de aceitar novas compras");
    await sleep(350);
    await click("Arquivar");
    await see("Cartão arquivado.");
    await modalClosed();
    await waitFor("!(" + hasText("Nova compra") + ")", "sumiu nova compra");
    await click("Reativar");
    await see("Cartão reativado.");
  });

  // ------------------------------------------------------------ Captura
  let token;
  const post = (body, bearer = token) =>
    fetch(`${BASE}/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  await check("[Captura] token criado pela tela aparece uma vez e só o hash fica no banco", async () => {
    await goto("/agente");
    await evalJs(`document.querySelector('a[href="/agente/conexoes"]').click()`);
    await waitFor(`location.pathname==='/agente/conexoes'`, "rota");
    await see("Configurar no iPhone");
    await click("Criar token");
    await see("não será mostrado de novo");
    token = await evalJs(`document.querySelector('code[aria-label=token]').innerText`);
    if (!token.startsWith("wos_")) throw new Error("token");
    await shot("34-captura-desktop");
    const stored = await count("select count(*) from public.capture_tokens where token_hash=$1", [token]);
    if (stored !== 0) throw new Error("token em texto puro");
    await goto("/agente/conexoes");
    if (await evalJs(hasText("wos_"))) throw new Error("token reaparece");
    await see("ainda sem uso");
  });

  await check("[Captura] endpoint recusa acesso sem token válido, sem redirecionar", async () => {
    const none = await post({ source: "apple_pay", merchant: "X", amount: "R$ 1,00", card: "Nubank" }, null);
    const bad = await post({ source: "apple_pay", merchant: "X", amount: "R$ 1,00", card: "Nubank" }, "wos_invalido_invalido_invalido");
    if (none.status !== 401 || bad.status !== 401) throw new Error(`${none.status}/${bad.status}`);
    const malformed = await post("{nao-e-json");
    const invalid = await post({ source: "hack", text: "x" });
    const big = await post({ source: "sms", text: "x".repeat(9000) });
    if (malformed.status !== 400 || invalid.status !== 400 || big.status !== 413) throw new Error(`${malformed.status}/${invalid.status}/${big.status}`);
    const text = await bad.text();
    if (/supabase|postgres|hint|stack/i.test(text)) throw new Error("vazou detalhe: " + text);
  });

  await check("[Captura] Apple Pay vira compra na fatura do cartão certo, sem mexer no saldo", async () => {
    const before = await balance("Principal");
    const res = await post({ source: "apple_pay", merchant: "PADARIA CENTRAL", amount: "R$ 25,90", card: "Nubank Ultravioleta", location: "Rua A, 10" });
    const body = await res.json();
    if (body.status !== "created") throw new Error(JSON.stringify(body));
    const row = (await db.query("select amount_cents, card_id, account_id, notes, posted_at::text as d from public.transactions where description='PADARIA CENTRAL'")).rows[0];
    if (Number(row.amount_cents) !== -2590 || row.card_id !== cardId || row.account_id !== null) throw new Error("linha");
    if (!row.notes.includes("Rua A, 10") || row.d !== today) throw new Error("detalhes");
    if ((await balance("Principal")) !== before) throw new Error("saldo");
  });

  await check("[Captura] repetição do atalho não duplica", async () => {
    const res = await post({ source: "apple_pay", merchant: "PADARIA CENTRAL", amount: "R$ 25,90", card: "Nubank" });
    if ((await res.json()).status !== "duplicate") throw new Error("não reconheceu");
    if ((await count("select count(*) from public.transactions where description='PADARIA CENTRAL'")) !== 1) throw new Error("duplicou");
  });

  await check("[Captura] notificação de Pix recebido entra na conta e soma no saldo", async () => {
    const before = await balance("Principal");
    const res = await post({ source: "notification", text: "Você recebeu um Pix de R$ 150,00 de João Silva", card: "Principal" });
    if ((await res.json()).status !== "created") throw new Error("status");
    if ((await balance("Principal")) !== before + 15000) throw new Error("saldo");
    const row = (await db.query("select kind, payment_method from public.transactions where description='João Silva'")).rows[0];
    if (row.kind !== "income" || row.payment_method !== "pix") throw new Error("tipo");
  });

  await check("[Captura] códigos de segurança são descartados e não ficam guardados", async () => {
    const before = await count("select count(*) from public.capture_events");
    for (const text of ["Seu código é 123456, compra de R$ 10,00", "Sua fatura fechou em R$ 900,00", "Bom dia"]) {
      const res = await post({ source: "sms", text });
      if ((await res.json()).status !== "ignored") throw new Error(text);
    }
    if ((await count("select count(*) from public.capture_events")) !== before) throw new Error("guardou");
    const invalid = await post({ source: "sms", text: "Bom dia" }, "wos_invalido_invalido_invalido");
    if (invalid.status !== 401) throw new Error("mensagem ignorada não validou o token");
  });

  await check("[Captura] o que não dá para classificar fica para revisar, e a tela resolve", async () => {
    const before = await balance("Principal");
    await post({ source: "apple_pay", merchant: "Loja Misteriosa", amount: "R$ 77,00", card: "Banco Inexistente" });
    await post({ source: "apple_pay", merchant: "Loja Descartada", amount: "R$ 11,00", card: "Banco Inexistente" });
    if ((await balance("Principal")) !== before) throw new Error("entrou no saldo");
    await goto("/transacoes");
    await see("lançamentos capturados aguardam revisão");
    await goto("/agente/revisao");
    await see("Loja Misteriosa");
    await see("Não identifiquei a conta ou o cartão");
    const principal = (await db.query("select id from public.bank_accounts where name='Principal'")).rows[0].id;
    await shot("35-captura-revisao-desktop");
    await evalJs(`(()=>{const li=[...document.querySelectorAll('#pendentes li')].find(l=>l.innerText.includes('Loja Misteriosa'));
      const s=li.querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'account:${principal}');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await sleep(200);
    await evalJs(`[...[...document.querySelectorAll('#pendentes li')].find(l=>l.innerText.includes('Loja Misteriosa')).querySelectorAll('button')].find(b=>b.innerText.trim()==='Registrar').click()`);
    await see("Lançamento registrado.");
    await waitFor(`!document.querySelector('#pendentes').innerText.includes('Loja Misteriosa')`, "saiu da lista");
    if ((await balance("Principal")) !== before - 7700) throw new Error("não debitou");
    await evalJs(`[...[...document.querySelectorAll('#pendentes li')].find(l=>l.innerText.includes('Loja Descartada')).querySelectorAll('button')].find(b=>b.innerText.trim()==='Descartar').click()`);
    await see("Item descartado.");
    if ((await count("select count(*) from public.transactions where description='Loja Descartada'")) !== 0) throw new Error("gravou");
  });

  // ------------------------------------------------------------ Pluggy
  const principal = (await db.query("select id from public.bank_accounts where name='Principal'")).rows[0].id;
  const state = {
    calls: [],
    accounts: [
      { id: "pl-bank", type: "BANK", name: "Conta Corrente", marketingName: "Conta Itaú", number: "12345-6" },
      { id: "pl-card", type: "CREDIT", name: "Cartão", marketingName: "Nubank Roxo", number: "xxxx1234" },
    ],
    transactions: {
      "pl-bank": [
        { id: "b1", description: "PIX ENVIADO MARIA", amount: 50, type: "DEBIT", status: "POSTED", date: `${today}T00:00:00.000Z` },
        { id: "b2", description: "SALARIO EMPRESA", amount: 1000, type: "CREDIT", status: "POSTED", date: `${today}T00:00:00.000Z` },
        { id: "b3", description: "AGENDADO", amount: 999, type: "DEBIT", status: "PENDING", date: `${today}T00:00:00.000Z` },
        { id: "b4", description: "PAG FATURA", amount: 300, type: "DEBIT", status: "POSTED", operationType: "PAGAMENTO_FATURA", date: `${today}T00:00:00.000Z` },
      ],
      "pl-card": [
        { id: "c1", description: "PADARIA CENTRAL LTDA", amount: 25.9, status: "PENDING", date: `${today}T00:00:00.000Z` },
        { id: "c2", description: "LOJA ONLINE", amount: 19.99, status: "PENDING", date: `${today}T00:00:00.000Z`, creditCardMetadata: { installmentNumber: 1, totalInstallments: 2 } },
        { id: "c3", description: "Pagamento recebido", amount: -100, status: "POSTED", operationType: "PAGAMENTO_FATURA", date: `${today}T00:00:00.000Z` },
      ],
    },
  };
  const fake = await startFakePluggy(state);

  try {
    await check("[Pluggy] tela lista as contas e liga cada uma ao destino", async () => {
      await goto("/agente/conexoes");
      await setVal("input[name=itemId]", "item-1-do-banco");
      await click("Adicionar conexão");
      await see("Conexão adicionada.");
      await click("Ver contas do banco");
      await see("Nubank Roxo");
      await see("Conta Itaú");
      const options = await evalJs(`[...document.querySelector('select[aria-label="Ligar Nubank Roxo"]').options].map(o=>o.text).join('|')`);
      if (!options.includes("Roxinho") || options.includes("Principal")) throw new Error(options);
      await setVal('select[aria-label="Ligar Nubank Roxo"]', `card:${cardId}`);
      await see("Conta ligada.");
      await sleep(500);
      await setVal('select[aria-label="Ligar Conta Itaú"]', `account:${principal}`);
      await waitFor(`document.querySelector('select[aria-label="Ligar Conta Itaú"]').value.startsWith('account:')`, "vínculo");
      await sleep(800);
      if ((await count("select count(*) from public.pluggy_links")) !== 2) throw new Error("vínculos");
      await shot("36-captura-pluggy-desktop");
    });

    let afterSync;

    await check("[Pluggy] sincronizar: cria, reconhece o que veio do Apple Pay e separa fatura", async () => {
      const before = await balance("Principal");
      await goto("/agente/conexoes");
      await click("Sincronizar agora");
      await see("Sincronizado:");
      afterSync = await balance("Principal");
      if (afterSync !== before - 5000 + 100000) throw new Error(`saldo ${afterSync} vs ${before}`);
      const padaria = await count("select count(*) from public.transactions where description ilike 'PADARIA CENTRAL%'");
      if (padaria !== 1) throw new Error("duplicou Apple Pay + banco: " + padaria);
      if ((await count("select count(*) from public.transactions where description='AGENDADO'")) !== 0) throw new Error("agendado entrou");
      if ((await count("select count(*) from public.transactions where description='PAG FATURA'")) !== 0) throw new Error("fatura virou despesa");
      if ((await count("select count(*) from public.capture_events where description='PAG FATURA' and status='pending'")) !== 1) throw new Error("fatura não foi para revisão");
      if ((await count("select count(*) from public.transactions where description='Pagamento recebido'")) !== 0) throw new Error("pagamento do cartão entrou");
      const parcel = (await db.query("select amount_cents, card_id from public.transactions where description='LOJA ONLINE (1/2)'")).rows[0];
      if (Number(parcel.amount_cents) !== -1999 || parcel.card_id !== cardId) throw new Error("parcela");
      if (!state.calls.some((c) => c.includes("after="))) throw new Error("não paginou");
    });

    await check("[Pluggy] sincronizar de novo não duplica nada", async () => {
      const txs = await count("select count(*) from public.transactions");
      await sleep(4600);
      await click("Sincronizar agora");
      await see("0 novos");
      if ((await count("select count(*) from public.transactions")) !== txs) throw new Error("duplicou");
      if ((await balance("Principal")) !== afterSync) throw new Error("saldo");
    });

    await check("[Pluggy] agendador: exige segredo e sincroniza com o token", async () => {
      const denied = await fetch(`${BASE}/api/cron/agent`);
      const wrong = await fetch(`${BASE}/api/cron/agent`, { headers: { authorization: "Bearer errado" } });
      if (denied.status !== 401 || wrong.status !== 401) throw new Error(`${denied.status}/${wrong.status}`);
      state.transactions["pl-bank"].push({ id: "b5", description: "PIX DO AGENDADOR", amount: 12, type: "CREDIT", status: "POSTED", date: `${today}T00:00:00.000Z` });
      const ok = await fetch(`${BASE}/api/cron/agent`, { headers: { authorization: "Bearer cron-secreto" } });
      const body = await ok.json();
      if (ok.status !== 200 || body.sync.created !== 1) throw new Error(JSON.stringify(body));
      if ((await balance("Principal")) !== afterSync + 1200) throw new Error("saldo");
    });

    await check("[Pluggy] credenciais nunca chegam ao navegador", async () => {
      const html = await evalJs(`document.documentElement.outerHTML`);
      if (html.includes("SEGREDO_PLUGGY_E2E") || html.includes("chave-api") || html.includes("wos_token_do_agendador")) throw new Error("vazou");
    });

    await check("[Pluggy] falha da API mostra aviso e não altera dados", async () => {
      await new Promise((r) => fake.close(r));
      const txs = await count("select count(*) from public.transactions");
      await sleep(4600);
      await click("Sincronizar agora");
      await see("Não foi possível sincronizar");
      if ((await count("select count(*) from public.transactions")) !== txs) throw new Error("alterou");
    });
  } finally {
    fake.close();
  }

  await viewport(390, 844, true);
  await check("[M4/M5/Captura] celular sem rolagem horizontal", async () => {
    await goto("/cartoes");
    await see("Limite disponível");
    await shot("37-cartoes-mobile");
    await noOverflow("cartões");
    await goto(`/cartoes/${cardId}`);
    await see("Detalhes");
    await shot("38-cartao-mobile");
    await noOverflow("cartão");
    await click("Nova compra");
    await modal("input[name=description]");
    await sleep(500);
    await shot("39-form-compra-mobile");
    await click("Cancelar");
    await modalClosed();
    const inv = (await db.query("select id from public.card_invoices where card_id=$1 limit 1", [cardId])).rows[0].id;
    await goto(`/cartoes/${cardId}/faturas/${inv}`);
    await see("Compras");
    await shot("40-fatura-mobile");
    await noOverflow("fatura");
    await goto("/agente/conexoes");
    await see("Configurar no iPhone");
    await shot("41-conexoes-mobile");
    await noOverflow("captura");
  });
  await viewport(1280, 860, false);
}

export async function runB(h) {
  const { check, goto, see, notSee, evalJs, db, waitFor, hasText } = h;
  const cardId = (await db.query("select id from public.credit_cards where name='Roxinho'")).rows[0].id;
  const invoiceId = (await db.query("select id from public.card_invoices where card_id=$1 limit 1", [cardId])).rows[0].id;
  const notFound = hasText("404") + " || " + hasText("could not be found");

  await check("[isolamento] B não vê cartões nem faturas de A, nem por URL", async () => {
    await goto("/cartoes");
    await see("Nenhum cartão cadastrado");
    await goto(`/cartoes/${cardId}`);
    await waitFor(notFound, "404 cartão");
    await goto(`/cartoes/${cardId}/faturas/${invoiceId}`);
    await waitFor(notFound, "404 fatura");
    if (await evalJs(hasText("Roxinho"))) throw new Error("vazou");
  });

  await check("[isolamento] B não vê tokens, vínculos nem pendências de A", async () => {
    await goto("/agente/revisao");
    await see("Nada para revisar");
    if (!(await notSee("PAG FATURA"))) throw new Error("pendência de A");
    if (await evalJs(hasText("Agendador"))) throw new Error("token de A");
  });
}
