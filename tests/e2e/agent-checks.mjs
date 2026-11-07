// Checagens E2E do Financial Agent: painel, boletos, importação, conversa, pausa, webhook.
const BASE = "http://127.0.0.1:3100";

const brl = (cents) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/ /g, " ");

export async function runA(h) {
  const { check, goto, see, notSee, click, setVal, evalJs, waitFor, shot, db, scalar, viewport, hasText, USERS } = h;
  await viewport(1280, 860, false);

  const userA = USERS["a@teste.dev"];
  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const [year, month, day] = today.split("-");
  const account = (await db.query("select id from public.bank_accounts where name='Principal' and user_id=$1", [userA])).rows[0].id;
  const balance = async () => Number(await scalar("select balance_cents from public.bank_accounts where id=$1", [account]));
  const cron = () => fetch(`${BASE}/api/cron/agent`, { headers: { authorization: "Bearer cron-secreto" } });

  await check("[Agente] item na navegação abre o painel com o estado real", async () => {
    await goto("/overview");
    await evalJs(`document.querySelector('a[href="/agente"]').click()`);
    await waitFor(`location.pathname==='/agente'`, "rota");
    await see("Estado");
    await see("Para revisar");
    await see("Instituições");
    await shot("50-agente-painel");
  });

  await check("[Agente] link antigo da captura leva às conexões", async () => {
    await goto("/configuracoes/captura");
    await waitFor(`location.pathname==='/agente/conexoes'`, "redirecionamento");
    await see("Configurar no iPhone");
  });

  await check("[Boletos] cadastrar não marca como pago", async () => {
    await goto("/agente/boletos");
    await see("Nenhum boleto em aberto");
    await setVal("input[name=beneficiary]", "Energia Teste");
    await setVal("#bill-amount", "150,00");
    await setVal("input[name=dueDate]", today);
    await click("Cadastrar boleto");
    await see("Boleto cadastrado.");
    await see("Energia Teste");
    const paid = await scalar("select paid_at from public.bills where beneficiary='Energia Teste'");
    if (paid !== null) throw new Error("marcou pago");
    await notSee("Pago em");
    await shot("51-boletos");
  });

  await check("[Boletos] só fica pago com transação confirmada", async () => {
    await db.query(
      `insert into public.transactions (user_id, account_id, posted_at, description, amount_cents, kind, payment_method, dedupe_hash)
       values ($1, $2, $3, 'PAGTO BOLETO ENERGIA TESTE', -15000, 'expense', 'boleto', 'e2e-boleto-1')`,
      [userA, account, today],
    );
    await goto("/agente/boletos");
    await see("Pago em");
    await see("Nenhum boleto em aberto");
  });

  const csv = `Data;Descrição;Valor\n${day}/${month}/${year};MERCADO IMPORTADO;-47,13\n${day}/${month}/${year};RENDA IMPORTADA;1037,29\n`;
  const pickFile = async () => {
    await goto("/agente/importar");
    await see("Importar extrato");
    await setVal("#import-target", `account:${account}`);
    await evalJs(`(()=>{const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(csv)}],'extrato.csv',{type:'text/csv'}));
      const i=document.querySelector('#import-file');i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click("Ler arquivo");
    await see("Revisar extrato.csv");
  };
  const before = { value: 0 };

  await check("[Importar] prévia não grava nada", async () => {
    before.value = await balance();
    await pickFile();
    await waitFor(`[...document.querySelectorAll('input[aria-label=Descrição]')].some(i=>i.value==='MERCADO IMPORTADO')`, "linha");
    const events = await scalar("select count(*) from public.capture_events where source='csv'");
    if (Number(events) !== 0 || (await balance()) !== before.value) throw new Error("gravou na prévia");
    await shot("52-importar-previa");
  });

  await check("[Importar] confirma, ajusta saldo e guarda o histórico", async () => {
    await click("Importar 2");
    await see("Resultado da importação");
    await see("2 registrados");
    if ((await balance()) !== before.value - 4713 + 103729) throw new Error("saldo " + (await balance()));
    const row = (await db.query("select status, rows_inserted from public.import_batches order by created_at desc limit 1")).rows[0];
    if (row.status !== "completed" || row.rows_inserted !== 2) throw new Error(JSON.stringify(row));
    const linked = await scalar("select count(*) from public.transactions where batch_id is not null");
    if (Number(linked) !== 2) throw new Error("lote " + linked);
    await see("extrato.csv");
  });

  await check("[Importar] o mesmo arquivo de novo não duplica", async () => {
    const after = await balance();
    await pickFile();
    await see("Já importada antes");
    const disabled = await evalJs(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Importar 0')?.disabled`);
    if (disabled !== true) throw new Error("permitiu");
    if ((await balance()) !== after) throw new Error("saldo");
  });

  await check("[Importar] arquivo inválido mostra erro claro", async () => {
    await goto("/agente/importar");
    await see("Importar extrato");
    await setVal("#import-target", `account:${account}`);
    await evalJs(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['isto nao e extrato'],'x.csv',{type:'text/csv'}));
      const i=document.querySelector('#import-file');i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click("Ler arquivo");
    await waitFor(`document.querySelector('[role=alert],[role=status]')!==null`, "aviso");
    await see("Importar extrato");
  });

  await check("[Conversa] responde com o valor real, o período e a origem", async () => {
    const { rows } = await db.query(
      `select coalesce(sum(case when kind='refund' then -abs(amount_cents) when amount_cents<0 and kind not in ('transfer','invoice_payment') then -amount_cents else 0 end),0)::bigint as total
         from public.transactions where user_id=$1 and posted_at=$2`,
      [userA, today],
    );
    await goto("/agente/conversa");
    await click("Quanto gastei hoje?");
    await see(brl(Number(rows[0].total)));
    await see("Período: hoje");
    await see("Transações registradas no WALLET OS");
    await shot("53-conversa");
  });

  await check("[Conversa] pergunta com a palavra pagar não executa nada", async () => {
    const txs = await scalar("select count(*) from public.transactions");
    await setVal('input[aria-label="Pergunte ao agente"]', "Faça um Pix de 100 reais para o João");
    await evalJs(`document.querySelector('button[aria-label=Enviar]').click()`);
    await see("Ainda não sei responder");
    if ((await scalar("select count(*) from public.transactions")) !== txs) throw new Error("gravou");
  });

  await check("[Atividade] mostra o que o agente fez", async () => {
    await goto("/agente/atividade");
    await see("Linha do tempo");
    await see("MERCADO IMPORTADO");
    await shot("54-atividade");
  });

  await check("[Pausa] pausado, o agendador não sincroniza nem cria alertas", async () => {
    await goto("/agente/configuracoes");
    await waitFor(`document.querySelector('[role=switch][aria-label="Pausar o agente"]')!==null`, "chave");
    await evalJs(`document.querySelector('[role=switch][aria-label="Pausar o agente"]').click()`);
    await click("Salvar configurações");
    await see("Agente pausado.");
    await shot("55-configuracoes");
    const response = await cron();
    const body = await response.json();
    if (body.sync?.skipped !== "paused") throw new Error(JSON.stringify(body));
    await goto("/agente");
    await see("Pausado");
  });

  await check("[Pausa] retomar volta a processar", async () => {
    await goto("/agente/configuracoes");
    await waitFor(`document.querySelector('[role=switch][aria-label="Pausar o agente"]')!==null`, "chave");
    await evalJs(`document.querySelector('[role=switch][aria-label="Pausar o agente"]').click()`);
    await click("Salvar configurações");
    await see("Configurações salvas.");
    const response = await cron();
    const body = await response.json();
    if (body.sync?.skipped === "paused" || body.automations?.error) throw new Error(JSON.stringify(body));
  });

  await check("[Webhook] exige o segredo e aceita eventos conhecidos", async () => {
    const post = (headers, payload) =>
      fetch(`${BASE}/api/webhooks/pluggy`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });
    const denied = await post({}, JSON.stringify({ event: "item/updated" }));
    const wrong = await post({ "x-wallet-webhook-secret": "errado" }, JSON.stringify({ event: "item/updated" }));
    const broken = await post({ "x-wallet-webhook-secret": "segredo-webhook" }, "{nao json");
    const ok = await post({ "x-wallet-webhook-secret": "segredo-webhook" }, JSON.stringify({ event: "connector/status_updated" }));
    if (denied.status !== 401 || wrong.status !== 401 || broken.status !== 400 || ok.status !== 200) {
      throw new Error(`${denied.status}/${wrong.status}/${broken.status}/${ok.status}`);
    }
  });

  await viewport(390, 844, true);
  await check("[Agente] celular sem rolagem horizontal em nenhuma aba", async () => {
    for (const path of ["/agente", "/agente/revisao", "/agente/conversa", "/agente/atividade", "/agente/conexoes", "/agente/importar", "/agente/boletos", "/agente/configuracoes"]) {
      await goto(path);
      await waitFor(`document.querySelector('nav[aria-label="Seções do agente"]')!==null`, "abas");
      const overflow = await evalJs(`document.documentElement.scrollWidth - window.innerWidth`);
      if (overflow > 0) throw new Error(`${path}: ${overflow}px`);
    }
    await goto("/agente");
    await see("Estado");
    await shot("56-agente-mobile");
    await goto("/agente/conversa");
    await see("O agente só consulta");
    await shot("57-conversa-mobile");
  });
  await viewport(1280, 860, false);
  void hasText;
}

export async function runB(h) {
  const { check, goto, see, evalJs, click, hasText } = h;

  await check("[isolamento] B não vê boletos, importações nem atividade de A", async () => {
    await goto("/agente/boletos");
    await see("Nenhum boleto em aberto");
    if (await evalJs(hasText("Energia Teste"))) throw new Error("boleto de A");
    await goto("/agente/importar");
    await see("Importar extrato");
    if (await evalJs(hasText("extrato.csv"))) throw new Error("importação de A");
    await goto("/agente/atividade");
    await see("Nenhuma atividade ainda");
    if (await evalJs(hasText("MERCADO IMPORTADO"))) throw new Error("atividade de A");
    await goto("/agente/conexoes");
    await see("Bancos (Open Finance)");
    if (await evalJs(hasText("Itaú"))) throw new Error("conexão de A");
  });

  await check("[isolamento] a conversa de B só responde com os dados de B", async () => {
    await goto("/agente/conversa");
    await click("Quanto gastei hoje?");
    await see("Não encontrei dados suficientes");
  });
}
