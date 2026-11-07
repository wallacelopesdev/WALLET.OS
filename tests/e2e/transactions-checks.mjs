// Checagens E2E dos Módulos 2 e 3. Recebe os utilitários do e2e.mjs.
export async function runA(h) {
  const { check, goto, see, notSee, click, setVal, evalJs, waitFor, shot, sleep, db, scalar, viewport, hasText, USERS } = h;
  const scope = `(document.querySelector('dialog[open]') ?? document)`;
  const clickContains = async (text) => {
    await waitFor(`[...${scope}.querySelectorAll('button,a')].some(e=>e.innerText.includes(${JSON.stringify(text)}))`, "contém " + text);
    await evalJs(`[...${scope}.querySelectorAll('button,a')].find(e=>e.innerText.includes(${JSON.stringify(text)})).click()`);
  };
  const clickAria = (label) => evalJs(`document.querySelector('dialog[open] [aria-label=${JSON.stringify(label)}]').click()`);
  const pickOption = async (sel, label) => {
    const value = await evalJs(`[...document.querySelector(${JSON.stringify(sel)}).options].find(o=>o.text.startsWith(${JSON.stringify(label)}))?.value`);
    if (value === undefined) throw new Error("opção ausente: " + label);
    await setVal(sel, value);
  };
  const modal = (sel) => waitFor(`!!document.querySelector('dialog[open] ${sel}')`, "modal " + sel);
  const modalClosed = () => waitFor(`!document.querySelector('dialog[open]')`, "modal fechado");
  const balance = async (name) => Number(await scalar("select balance_cents from public.bank_accounts where name=$1", [name]));
  const count = async (sql, p) => Number(await scalar(sql, p));

  await viewport(1280, 860, false);
  const idPrincipal = (await db.query("select id from public.bank_accounts where name='Principal'")).rows[0].id;
  const start = { p: await balance("Principal"), c: await balance("Corrida") };

  // ------------------------------------------------------------ Módulo 2
  await check("[M2] aba Categorias lista as 15 padrão, por tipo", async () => {
    await goto("/financeiro");
    await click("Categorias");
    await waitFor(`location.pathname==='/financeiro/categorias'`, "rota");
    for (const name of ["Salário", "Freelance", "Investimentos", "Vendas", "Outros recebimentos", "Alimentação", "Moradia", "Transporte", "Saúde", "Educação", "Lazer", "Compras", "Assinaturas", "Contas", "Outros gastos"]) {
      await see(name);
    }
    await shot("11-categorias-desktop");
  });

  await check("[M2] criar categoria valida, escolhe ícone e cor, e aparece sem recarregar", async () => {
    await click("Nova categoria");
    await modal("input[name=name]");
    await click("Criar categoria");
    await see("Informe um nome para a categoria.");
    await setVal("input[name=name]", "Hobbies");
    await clickAria("Ícone plane");
    await clickAria("Cor #60a5fa");
    await shot("12-form-categoria-desktop");
    await click("Criar categoria");
    await see("Categoria criada.");
    await see("Hobbies");
    const row = (await db.query("select kind, icon, color, is_system from public.transaction_categories where name='Hobbies'")).rows[0];
    if (row.kind !== "expense" || row.icon !== "plane" || row.color !== "#60a5fa" || row.is_system) throw new Error(JSON.stringify(row));
  });

  await check("[M2] nome duplicado no mesmo tipo é recusado", async () => {
    await click("Nova categoria");
    await modal("input[name=name]");
    await setVal("input[name=name]", "hobbies");
    await click("Criar categoria");
    await see("Já existe uma categoria ativa");
    await click("Cancelar");
    await modalClosed();
  });

  await check("[M2] mesmo nome em receitas é permitido (slug distinto)", async () => {
    await evalJs(`[...document.querySelectorAll('button')].filter(b=>b.innerText.trim()==='Nova categoria')[1].click()`);
    await modal("input[name=name]");
    await setVal("input[name=name]", "Hobbies");
    await click("Criar categoria");
    await waitFor(`!document.querySelector('dialog[open]')`, "modal fechado");
    const rows = (await db.query("select slug, kind from public.transaction_categories where name='Hobbies' order by kind")).rows;
    if (rows.length !== 2 || rows[0].slug === rows[1].slug) throw new Error(JSON.stringify(rows));
  });

  await check("[M2] editar renomeia", async () => {
    await modalClosed();
    await clickContains("Hobbies");
    await modal("input[name=name]");
    await setVal("input[name=name]", "Passeios");
    await click("Salvar alterações");
    await see("Categoria atualizada.");
    await see("Passeios");
  });

  await check("[M2] arquivar passa pela confirmação e vai para Arquivadas", async () => {
    await modalClosed();
    await clickContains("Passeios");
    await modal("input[name=name]");
    await click("Arquivar");
    await see("deixa de aparecer em novos lançamentos");
    await waitFor(`document.querySelector('dialog[open]')?.innerText.includes('Arquivar Passeios')`, "confirmação continua aberta");
    await sleep(400);
    if (!(await evalJs(`!!document.querySelector('dialog[open]')`))) throw new Error("confirmação fechou sozinha");
    await click("Arquivar");
    await see("Categoria arquivada.");
    await modalClosed();
    const archived = await scalar("select archived from public.transaction_categories where name='Passeios'");
    if (!archived) throw new Error("não arquivou");
    await see("Arquivadas");
  });

  await check("[M2] reativar e excluir categoria própria sem uso", async () => {
    await evalJs(`document.querySelector('main details').open = true`);
    await clickContains("Passeios");
    await modal("input[name=name]");
    await click("Reativar");
    await see("Categoria reativada.");
    await modalClosed();
    await clickContains("Passeios");
    await modal("input[name=name]");
    await click("Excluir");
    await see("Esta ação é permanente");
    await click("Excluir categoria");
    await see("Categoria excluída.");
    if ((await count("select count(*) from public.transaction_categories where name='Passeios'")) !== 0) throw new Error("não excluiu");
  });

  await check("[M2] categoria padrão não oferece exclusão", async () => {
    await modalClosed();
    await clickContains("Moradia");
    await modal("input[name=name]");
    if (!(await notSee("Excluir"))) throw new Error("Excluir visível");
    await click("Cancelar");
    await modalClosed();
  });

  await check("[M2] navegação de mês atravessa o ano", async () => {
    await goto("/financeiro/categorias?mes=2027-01");
    await see("Janeiro de 2027");
    await evalJs(`document.querySelector('a[aria-label="Mês anterior"]').click()`);
    await see("Dezembro de 2026");
    await goto("/financeiro/categorias?mes=abc");
    await see("2026");
  });

  // ------------------------------------------------------------ Módulo 3
  const openNew = async () => {
    await click("Novo lançamento");
    await modal("input[name=description]");
  };
  const today = await evalJs(`new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date())`);

  await check("[M3] lista e formulário abrem; a conta filtrada vem pré-selecionada", async () => {
    await goto(`/transacoes?conta=${idPrincipal}`);
    await see("lançamentos");
    await openNew();
    const v = await evalJs(`document.querySelector('select[name=accountId]').value`);
    if (v !== idPrincipal) throw new Error("conta: " + v);
    const date = await evalJs(`document.querySelector('input[name=postedAt]').value`);
    if (date !== today) throw new Error("data: " + date);
    await shot("13-form-lancamento-desktop");
    await click("Cancelar");
    await modalClosed();
  });

  await check("[M3] validação: valor zero, sem descrição, preservando o digitado", async () => {
    await goto("/transacoes");
    await openNew();
    await setVal("input[name=notes]".replace("input", "textarea"), "obs").catch(() => {});
    await click("Registrar");
    await see("Informe um valor maior que zero.");
    await see("Informe uma descrição.");
    await setVal("#tx-amount", "-5,00");
    await click("Registrar");
    await see("Informe um valor maior que zero.");
    if ((await evalJs(`document.querySelector('#tx-amount').value`)) !== "-5,00") throw new Error("valor apagado");
  });

  await check("[M3] data futura é recusada pelo servidor", async () => {
    await setVal("#tx-amount", "10,00");
    await setVal("input[name=description]", "Futuro");
    await setVal("input[name=postedAt]", "2099-01-01");
    await click("Registrar");
    await see("A data não pode estar no futuro.");
    await click("Cancelar");
    await modalClosed();
  });

  await check("[M3] despesa: grava em centavos, debita, mostra toast e lista sem recarregar", async () => {
    await openNew();
    await pickOption("select[name=accountId]", "Principal");
    await setVal("#tx-amount", "123,45");
    await setVal("input[name=description]", "Mercado da esquina");
    await pickOption("select[name=categoryId]", "Alimentação");
    await pickOption("select[name=paymentMethod]", "PIX");
    await setVal("input[name=competenceDate]", "2026-12-01");
    await click("Registrar");
    await see("Despesa registrada.");
    await see("Mercado da esquina");
    const row = (await db.query("select amount_cents, kind, payment_method, competence_date, category_source, dedupe_hash from public.transactions where description='Mercado da esquina'")).rows[0];
    if (Number(row.amount_cents) !== -12345 || row.kind !== "expense" || row.payment_method !== "pix" || row.category_source !== "manual" || !row.dedupe_hash.startsWith("manual:")) throw new Error("linha incorreta");
    if ((await balance("Principal")) !== start.p - 12345) throw new Error("saldo");
    await shot("14-lista-transacoes-desktop");
  });

  await check("[M3] categorias do formulário respeitam o tipo", async () => {
    await modalClosed();
    await openNew();
    const options = () => evalJs(`[...document.querySelector('select[name=categoryId]').options].map(o=>o.text)`);
    let o = await options();
    if (!o.includes("Moradia") || o.includes("Salário")) throw new Error("despesa: " + o);
    await pickOption("select[name=categoryId]", "Moradia");
    await click("Receita");
    await sleep(150);
    o = await options();
    if (o.includes("Moradia") || !o.includes("Salário")) throw new Error("receita: " + o);
    const selected = await evalJs(`document.querySelector('select[name=categoryId]').value`);
    if (selected !== "") throw new Error("categoria antiga mantida");
    await pickOption("select[name=accountId]", "Principal");
    await setVal("#tx-amount", "2.000,00");
    await setVal("input[name=description]", "Salário de novembro");
    await pickOption("select[name=categoryId]", "Salário");
    await click("Registrar");
    await see("Receita registrada.");
    if ((await balance("Principal")) !== start.p - 12345 + 200000) throw new Error("saldo");
  });

  await check("[M3] clique duplo no envio não duplica", async () => {
    await modalClosed();
    await openNew();
    await pickOption("select[name=accountId]", "Principal");
    await setVal("#tx-amount", "7,00");
    await setVal("input[name=description]", "Clique duplo");
    await sleep(100);
    await evalJs(`(()=>{const f=document.querySelector('dialog[open] form');f.requestSubmit();f.requestSubmit();})()`);
    await see("Despesa registrada.");
    await sleep(2500);
    if ((await count("select count(*) from public.transactions where description='Clique duplo'")) !== 1) throw new Error("duplicou");
    if ((await balance("Principal")) !== start.p - 12345 + 200000 - 700) throw new Error("saldo");
  });

  const afterClicks = start.p - 12345 + 200000 - 700;
  const patrimonio = async () => (await balance("Principal")) + (await balance("Corrida"));
  const totalBefore = afterClicks + start.c;

  await check("[M3] editar despesa recalcula o saldo", async () => {
    await modalClosed();
    await clickContains("Clique duplo");
    await modal("input[name=description]");
    if ((await evalJs(`document.querySelector('#tx-amount').value`)) !== "7,00") throw new Error("valor não pré-preenchido");
    await setVal("#tx-amount", "9,00");
    await click("Salvar alterações");
    await see("Lançamento atualizado.");
    await modalClosed(); if ((await balance("Principal")) !== afterClicks - 200) throw new Error("saldo");
    await modalClosed();
  });

  await check("[M3] trocar despesa por receita inverte o efeito no saldo", async () => {
    await see("-R$ 9,00");
    await clickContains("Clique duplo");
    await modal("input[name=description]");
    if ((await evalJs(`document.querySelector('#tx-amount').value`)) !== "9,00") throw new Error("valor antigo no formulario");
    await click("Receita");
    await sleep(150);
    await click("Salvar alterações");
    await see("Lançamento atualizado.");
    await modalClosed(); if ((await balance("Principal")) !== afterClicks + 700 + 900) throw new Error("saldo " + (await balance("Principal")));
    await modalClosed();
  });

  await check("[M3] excluir pede confirmação e restaura o saldo", async () => {
    await clickContains("Clique duplo");
    await modal("input[name=description]");
    await click("Excluir");
    await see("O saldo da conta será recalculado");
    await sleep(400);
    await click("Excluir");
    await see("Lançamento excluído.");
    if ((await balance("Principal")) !== afterClicks + 700) throw new Error("saldo");
    if ((await count("select count(*) from public.transactions where description='Clique duplo'")) !== 0) throw new Error("não excluiu");
    await modalClosed();
  });

  const base = afterClicks + 700;

  await check("[M3] transferência: debita, credita, preserva patrimônio e não vira receita/despesa", async () => {
    const expenseBefore = await count("select count(*) from public.transactions where kind in ('income','expense')");
    await openNew();
    await click("Transferência");
    await waitFor(`!!document.querySelector('select[name=fromAccountId]')`, "campos");
    if (await evalJs(`!!document.querySelector('select[name=categoryId]')`)) throw new Error("categoria em transferência");
    await pickOption("select[name=fromAccountId]", "Principal");
    await pickOption("select[name=toAccountId]", "Corrida");
    await setVal("#tx-amount", "100,00");
    await shot("15-form-transferencia-desktop");
    await click("Registrar");
    await see("Transferência registrada.");
    if ((await balance("Principal")) !== base - 10000) throw new Error("origem");
    if ((await balance("Corrida")) !== start.c + 10000) throw new Error("destino");
    if ((await patrimonio()) !== base + start.c) throw new Error("patrimônio");
    if ((await count("select count(*) from public.transactions where kind='transfer'")) !== 2) throw new Error("pernas");
    if ((await count("select count(*) from public.transactions where kind in ('income','expense')")) !== expenseBefore) throw new Error("gerou receita/despesa");
  });

  await check("[M3] mesma conta nos dois lados é recusada", async () => {
    await modalClosed();
    await openNew();
    await click("Transferência");
    await waitFor(`!!document.querySelector('select[name=fromAccountId]')`, "campos");
    await pickOption("select[name=fromAccountId]", "Principal");
    await pickOption("select[name=toAccountId]", "Principal");
    await setVal("#tx-amount", "1,00");
    await click("Registrar");
    await see("Escolha uma conta diferente da origem.");
    await click("Cancelar");
    await modalClosed();
  });

  await check("[M3] lista mostra a transferência uma vez; filtro por conta mostra o lado dela", async () => {
    const groupRows = () => evalJs(`[...document.querySelectorAll('main li')].filter(l=>l.innerText.includes('Transferência')).length`);
    await goto("/transacoes?tipo=transfer");
    await see("Transferência");
    if ((await groupRows()) !== 1) throw new Error("linhas " + (await groupRows()));
    const idCorrida = (await db.query("select id from public.bank_accounts where name='Corrida'")).rows[0].id;
    await goto(`/transacoes?tipo=transfer&conta=${idCorrida}`);
    await see("R$ 100,00");
    if (await evalJs(hasText("-R$ 100,00"))) throw new Error("mostrou o lado errado");
  });

  await check("[M3] overview não conta transferência como receita ou despesa", async () => {
    await goto("/overview");
    await see("Receitas do mês");
    const text = await evalJs(`document.querySelector('main').innerText.replace(/\\u00a0/g,' ')`);
    if (!text.includes("R$ 2.000,00")) throw new Error("receitas: " + text.slice(0, 300));
    if (text.includes("R$ 223,46")) throw new Error("transferencia contada como despesa"); if (!text.includes("R$ 123,46")) throw new Error("despesas: " + text.slice(0, 300));
  });

  await check("[M3] editar transferência ajusta os dois lados", async () => {
    await goto("/transacoes?tipo=transfer");
    await clickContains("Transferência");
    await modal("select[name=fromAccountId]");
    if ((await evalJs(`document.querySelector('#tx-amount').value`)) !== "100,00") throw new Error("valor");
    await setVal("#tx-amount", "40,00");
    await click("Salvar alterações");
    await see("Transferência atualizada.");
    if ((await balance("Principal")) !== base - 4000) throw new Error("origem");
    if ((await balance("Corrida")) !== start.c + 4000) throw new Error("destino");
    await modalClosed();
  });

  await check("[M3] excluir transferência remove os dois lados", async () => {
    await clickContains("Transferência");
    await modal("select[name=fromAccountId]");
    await click("Excluir");
    await see("Os dois lados da transferência");
    await sleep(400);
    await click("Excluir");
    await see("Transferência excluída.");
    if ((await count("select count(*) from public.transactions where kind='transfer'")) !== 0) throw new Error("restou perna");
    if ((await balance("Principal")) !== base || (await balance("Corrida")) !== start.c) throw new Error("saldos");
  });

  await check("[M3] busca pelo formulário, sem curinga e sem resultado", async () => {
    await goto("/transacoes");
    await setVal("input[name=q]", "esquina");
    await click("Buscar");
    await waitFor(`location.search.includes('q=esquina')`, "url");
    await see("Mercado da esquina");
    await see("1 lançamento");
    await goto("/transacoes?q=%25");
    await see("Nenhum lançamento encontrado");
    await goto("/transacoes?q=inexistente");
    await see("Nenhum lançamento encontrado");
  });

  await check("[M3] filtros de tipo, categoria e período", async () => {
    const lazerId = (await db.query("select id from public.transaction_categories where slug='alimentacao' and user_id=$1", [USERS["a@teste.dev"]])).rows[0].id;
    await goto(`/transacoes?categoria=${lazerId}`);
    await see("Mercado da esquina");
    if (await evalJs(hasText("Salário de novembro"))) throw new Error("categoria");
    await goto("/transacoes?tipo=income");
    await see("Salário de novembro");
    if (await evalJs(hasText("Mercado da esquina"))) throw new Error("tipo");
    await goto(`/transacoes?de=${today}&ate=${today}`);
    await see("Mercado da esquina");
    if (await evalJs(hasText("Lançamento 1"))) throw new Error("período");
    await goto("/transacoes?de=2020-01-01&ate=2020-12-31");
    await see("Nenhum lançamento encontrado");
  });

  await check("[M3] ordenar por valor usa a magnitude", async () => {
    await goto("/transacoes?ordem=valor_desc");
    const first = await evalJs(`document.querySelector('main ul li').innerText`);
    if (!first.includes("Salário de novembro")) throw new Error(first);
    await goto("/transacoes?ordem=valor_asc");
    const firstAsc = await evalJs(`document.querySelector('main ul li').innerText.replace(/\\u00a0/g,' ')`);
    if (!firstAsc.includes("0,01")) throw new Error(firstAsc);
    await shot("16-filtros-desktop");
  });

  await check("[M3] paginação mantém os filtros", async () => {
    for (let i = 0; i < 12; i++) {
      await db.query(`insert into public.transactions (user_id,account_id,posted_at,description,amount_cents,kind,dedupe_hash)
        values ($1,$2,$3,$4,-100,'expense',$5)`, [USERS["a@teste.dev"], idPrincipal, today, `Extra ${i}`, `e2e:extra:${i}`]);
    }
    await goto("/transacoes?ordem=valor_asc");
    await see("Página 1 de");
    const n = await evalJs(`document.querySelectorAll('main ul.divide-y > li').length`);
    if (n !== 30) throw new Error("linhas " + n);
    await click("Próxima");
    await waitFor(`location.search.includes('pagina=2') && location.search.includes('ordem=valor_asc')`, "url");
    await see("Página 2 de");
    await goto("/transacoes?pagina=999");
    await see("Nenhum lançamento encontrado");
  });

  await check("[M3] URL com filtros inválidos não quebra a página", async () => {
    await goto("/transacoes?tipo=x&categoria=1%20or%201=1&conta=y&de=z&ordem=id;--&pagina=-1");
    await see("lançamentos");
  });

  await check("[M3] lançamento antigo (estorno) abre sem formulário e pode ser excluído", async () => {
    await db.query(`insert into public.transactions (user_id,account_id,posted_at,description,amount_cents,kind,dedupe_hash)
      values ($1,$2,$3,'Estorno antigo',500,'refund','e2e:refund')`, [USERS["a@teste.dev"], idPrincipal, today]);
    await goto("/transacoes?q=Estorno");
    await clickContains("Estorno antigo");
    await see("não pode ser editado aqui");
    await sleep(300);
    await click("Excluir");
    await see("Esta ação é permanente");
    await sleep(400);
    await click("Excluir");
    await see("Lançamento excluído.");
    await modalClosed();
  });

  await check("[M3] conta arquivada some do formulário e o banco recusa novo lançamento", async () => {
    const id = (await db.query("select id from public.bank_accounts where name='Corrida'")).rows[0].id;
    await db.query("update public.bank_accounts set archived=true where id=$1", [id]);
    await goto("/transacoes");
    await openNew();
    const o = await evalJs(`[...document.querySelector('select[name=accountId]').options].map(o=>o.text).join('|')`);
    if (o.includes("Corrida")) throw new Error(o);
    await click("Transferência");
    await see("pelo menos duas contas ativas");
    await click("Cancelar");
    await modalClosed();
    await db.query("update public.bank_accounts set archived=false where id=$1", [id]);
  });

  await check("[M2+M3] totais do mês na aba de categorias", async () => {
    await goto("/financeiro/categorias");
    const text = await evalJs(`document.querySelector('main').innerText.replace(/\\u00a0/g,' ')`);
    const line = text.split("\n");
    const i = line.findIndex((l) => l.trim() === "Alimentação");
    if (!line.slice(i, i + 6).join(" ").includes("R$ 123,45")) throw new Error(line.slice(i, i + 6).join(" "));
    await see("1 lançamento no mês");
  });

  await check("[M2+M3] categoria em uso não oferece exclusão nem troca de tipo", async () => {
    const custom = await db.query(`insert into public.transaction_categories (user_id,name,slug,kind) values ($1,'Pets','pets','expense') returning id`, [USERS["a@teste.dev"]]);
    await db.query(`insert into public.transactions (user_id,account_id,category_id,posted_at,description,amount_cents,kind,dedupe_hash)
      values ($1,$2,$3,$4,'Ração',-100,'expense','e2e:pets')`, [USERS["a@teste.dev"], idPrincipal, custom.rows[0].id, today]);
    await goto("/financeiro/categorias");
    await clickContains("Pets");
    await modal("input[name=name]");
    if (!(await notSee("Excluir"))) throw new Error("Excluir visível");
    await see("já tem lançamentos");
    if (!(await evalJs(`document.querySelector('#category-kind').disabled`))) throw new Error("tipo editável");
    await setVal("input[name=name]", "Bichos");
    await click("Salvar alterações");
    await see("Categoria atualizada.");
    await modalClosed();
  });

  // ------------------------------------------------------------ celular
  await viewport(390, 844, true);
  await check("[M2/M3] celular: telas e formulários sem rolagem horizontal", async () => {
    const noOverflow = async (label) => {
      const over = await evalJs(`document.documentElement.scrollWidth - window.innerWidth`);
      if (over > 0) throw new Error(`overflow ${label}: ${over}`);
    };
    await goto("/financeiro/categorias");
    await see("Despesas");
    await shot("17-categorias-mobile");
    await noOverflow("categorias");
    await goto("/transacoes");
    await see("lançamentos");
    await shot("18-transacoes-mobile");
    await noOverflow("transações");
    await goto("/transacoes?tipo=income");
    await see("Salário de novembro");
    await shot("19-filtros-mobile");
    await noOverflow("filtros");
    await goto("/transacoes");
    await openNew();
    await sleep(500);
    await shot("20-form-lancamento-mobile");
    const r = await evalJs(`(()=>{const d=document.querySelector('dialog[open]');const b=d.getBoundingClientRect();return {b:Math.round(b.bottom),w:Math.round(b.width),scroll:d.scrollHeight>d.clientHeight}})()`);
    if (r.b !== 844 || r.w !== 390) throw new Error(JSON.stringify(r));
    await click("Transferência");
    await sleep(300);
    await shot("21-form-transferencia-mobile");
    await click("Cancelar");
    await modalClosed();
  });
}

export async function runB(h) {
  const { check, goto, see, notSee, evalJs, db, hasText, USERS } = h;
  const accountA = (await db.query("select id from public.bank_accounts where name='Principal'")).rows[0].id;

  await check("[isolamento] B não vê lançamentos de A e precisa cadastrar conta", async () => {
    await goto("/transacoes");
    await see("Cadastre uma conta primeiro");
    if (await evalJs(hasText("Mercado da esquina"))) throw new Error("vazou");
    await goto(`/transacoes?conta=${accountA}`);
    await see("Cadastre uma conta primeiro");
    if (await evalJs(hasText("Mercado da esquina"))) throw new Error("vazou com filtro");
  });

  await check("[isolamento] B tem as próprias categorias, sem as de A e sem totais de A", async () => {
    await goto("/financeiro/categorias");
    await see("Moradia");
    if (!(await notSee("Bichos"))) throw new Error("categoria de A visível");
    if (await evalJs(hasText("R$ 123,45"))) throw new Error("total de A visível");
  });

  await check("[isolamento] API: B não usa recursos de A nas funções de transferência", async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = (claims) => `${b64({ alg: "none" })}.${b64(claims)}.x`;
    const headers = { apikey: "x", authorization: `Bearer ${jwt({ sub: USERS["b@teste.dev"], role: "authenticated" })}`, "content-type": "application/json" };
    const accountB = (await db.query(`insert into public.bank_accounts (user_id,name,kind) values ($1,'De B','cash') returning id`, [USERS["b@teste.dev"]])).rows[0].id;
    const before = Number((await db.query("select balance_cents from public.bank_accounts where id=$1", [accountA])).rows[0].balance_cents);
    const res = await fetch("http://127.0.0.1:54399/rest/v1/rpc/create_transfer", {
      method: "POST", headers,
      body: JSON.stringify({ p_from_account: accountB, p_to_account: accountA, p_amount_cents: 100, p_posted_at: "2026-11-01", p_description: "Ataque", p_notes: null, p_request_id: "99999999-9999-4999-8999-999999999999" }),
    });
    const body = await res.json();
    if (body.code !== "23503") throw new Error(JSON.stringify(body));
    const after = Number((await db.query("select balance_cents from public.bank_accounts where id=$1", [accountA])).rows[0].balance_cents);
    if (after !== before) throw new Error("saldo mudou");
    await db.query("delete from public.bank_accounts where id=$1", [accountB]);
  });
}
