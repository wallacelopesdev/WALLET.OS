// Teste de ponta a ponta: Next real + Chrome real + stub de Auth/PostgREST sobre PGlite (RLS real).
// Nunca toca o banco de produção. Uso: npm run test:e2e
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT = process.cwd();
const OUT = path.join(PROJECT, "tests/e2e/.output");
mkdirSync(OUT, { recursive: true });

const { PGlite } = await import(
  pathToFileURL(path.join(PROJECT, "node_modules/@electric-sql/pglite/dist/index.js")).href
);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.x`;
const ANON = jwt({ role: "anon", iss: "stub" });
const USERS = {
  "a@teste.dev": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "b@teste.dev": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const userObj = (id, email) => ({
  id, email, aud: "authenticated", role: "authenticated",
  app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
});

// ------------------------------------------------------------- banco
const db = new PGlite({ parsers: { 1082: (v) => v } });
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);
const mig = (f) => readFileSync(path.join(PROJECT, "supabase/migrations", f), "utf8")
  .replace("create extension if not exists pgcrypto;", "");
await db.exec(mig("0001_init.sql"));
for (const file of ["0002_accounts.sql", "0003_categories.sql", "0004_transaction_types.sql", "0005_transactions.sql", "0006_cards.sql", "0007_capture.sql"]) {
  await db.exec(`begin;\n${mig(file)}\ncommit;`);
}
for (const [email, id] of Object.entries(USERS)) {
  await db.query("insert into auth.users (id,email) values ($1,$2)", [id, email]);
}

const { createHash } = await import("node:crypto");
await db.query("insert into public.capture_tokens (user_id,name,token_hash) values ($1,$2,$3)", [USERS["a@teste.dev"], "Agendador", createHash("sha256").update("wos_token_do_agendador_e2e").digest("hex")]);

// ------------------------------------------------------------- stub
const ident = (s) => { if (!/^[a-z0-9_]+$/.test(s)) throw new Error("ident " + s); return `"${s}"`; };
const OPS = { eq: "=", neq: "<>", gte: ">=", lte: "<=", gt: ">", lt: "<" };
const RESERVED = new Set(["select", "order", "limit", "offset", "columns", "or"]);

function parseSelect(sel, table) {
  const out = [];
  for (const part of (sel || "*").match(/[a-z0-9_*]+\([^)]*\)|[a-z0-9_*]+/g) ?? []) {
    const m = /^([a-z0-9_]+)\(([^)]*)\)$/.exec(part);
    if (m) {
      const cols = m[2].split(",").map(ident).join(",");
      out.push(`(select row_to_json(r) from (select ${cols} from public.${ident(m[1])} x where x.id = t.${m[1] === "credit_cards" ? "card_id" : "category_id"}) r) as ${ident(m[1])}`);
    } else out.push(part === "*" ? "t.*" : `t.${ident(part)}`);
  }
  return out.join(",");
}
function cond(column, expr, values) {
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const raw = expr.slice(dot + 1);
  if (op === "not") return `t.${ident(column)} is not null`;
  if (op === "is") return `t.${ident(column)} is ${raw === "null" ? "null" : "not null"}`;
  if (op === "in") {
    const list = raw.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, ""));
    values.push(list);
    return `t.${ident(column)}::text = any($${values.length}::text[])`;
  }
  if (op === "ilike") { values.push(raw); return `t.${ident(column)} ilike $${values.length}`; }
  if (!OPS[op]) throw new Error("op " + expr);
  values.push(raw);
  return `t.${ident(column)} ${OPS[op]} $${values.length}`;
}
function where(params, values) {
  const conds = [];
  for (const [k, v] of params) {
    if (k === "or") {
      const parts = v.replace(/^\(|\)$/g, "").split(",").map((p) => {
        const dot = p.indexOf(".");
        return cond(p.slice(0, dot), p.slice(dot + 1), values);
      });
      conds.push(`(${parts.join(" or ")})`);
    } else if (!RESERVED.has(k)) conds.push(cond(k, v, values));
  }
  return conds.length ? ` where ${conds.join(" and ")}` : "";
}
async function asRole(sub, fn) {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub ?? ""]);
    await db.exec(`set local role ${sub ? "authenticated" : "anon"}`);
    const r = await fn();
    await db.exec("commit");
    return r;
  } catch (e) { await db.exec("rollback"); throw e; }
}
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? Number(v) : v)));
};
const restLog = [];
const stub = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let raw = ""; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  const bearer = (req.headers.authorization ?? "").replace("Bearer ", "");
  let sub = null;
  try { sub = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url")).sub ?? null; } catch {}
  try {
    if (url.pathname === "/auth/v1/token") {
      const id = USERS[body.email];
      if (!id || body.password !== "senha-forte-123") return json(res, 400, { code: "invalid_credentials", error_code: "invalid_credentials", msg: "x" });
      const exp = Math.floor(Date.now() / 1000) + 3600;
      return json(res, 200, { access_token: jwt({ sub: id, role: "authenticated", exp, aud: "authenticated", email: body.email }), token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r" + id, user: userObj(id, body.email) });
    }
    if (url.pathname === "/auth/v1/user") {
      if (!sub) return json(res, 401, { msg: "no" });
      const email = Object.keys(USERS).find((e) => USERS[e] === sub);
      return json(res, 200, userObj(sub, email));
    }
    if (url.pathname.startsWith("/auth/v1/logout")) { res.writeHead(204); return res.end(); }
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (rpc) {
      const keys = Object.keys(body ?? {});
      const args = keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(",");
      const rows = await asRole(sub, async () =>
        (await db.query(`select * from public.${ident(rpc[1])}(${args})`, keys.map((k) => body[k]))).rows);
      const first = rows[0];
      if (first && Object.keys(first).length === 1 && rpc[1] in first) return json(res, 200, first[rpc[1]]);
      return json(res, 200, rows);
    }
    const m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
    if (!m) return json(res, 404, {});
    const table = `public.${ident(m[1])}`;
    const prefer = req.headers.prefer ?? "";
    const accept = req.headers.accept ?? "";
    const values = [];
    const select = parseSelect(url.searchParams.get("select"), m[1]);
    const wantsRows = req.method === "GET" || req.method === "HEAD" || prefer.includes("return=representation");
    const result = await asRole(sub, async () => {
      if (req.method === "GET" || req.method === "HEAD") {
        const w = where(url.searchParams, values);
        const order = url.searchParams.get("order");
        const ord = order ? " order by " + order.split(",").map((o) => {
          const [c, d] = o.split("."); return `t.${ident(c)} ${d === "desc" ? "desc" : "asc"}`;
        }).join(",") : "";
        const limit = url.searchParams.get("limit"), offset = url.searchParams.get("offset");
        const count = prefer.includes("count=exact")
          ? Number((await db.query(`select count(*) c from ${table} t${w}`, values)).rows[0].c) : null;
        const rows = (await db.query(`select ${select} from ${table} t${w}${ord}${limit ? ` limit ${Number(limit)}` : ""}${offset ? ` offset ${Number(offset)}` : ""}`, values)).rows;
        return { rows, count };
      }
      const ret = wantsRows ? ` returning ${select}` : "";
      if (req.method === "POST") {
        const keys = Object.keys(body);
        const q = `insert into ${table} as t (${keys.map(ident).join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})${ret}`;
        return { rows: (await db.query(q, keys.map((k) => body[k]))).rows };
      }
      if (req.method === "PATCH") {
        const keys = Object.keys(body);
        keys.forEach((k) => values.push(body[k]));
        const set = keys.map((k, i) => `${ident(k)} = $${i + 1}`).join(",");
        return { rows: (await db.query(`update ${table} as t set ${set}${where(url.searchParams, values)}${ret}`, values)).rows };
      }
      if (req.method === "DELETE") {
        return { rows: (await db.query(`delete from ${table} as t${where(url.searchParams, values)}${ret}`, values)).rows };
      }
      throw new Error("method");
    });
    restLog.push(`${req.method} ${m[1]} ${res.statusCode}`);
    const headers = result.count != null ? { "content-range": `0-${result.rows.length - 1}/${result.count}` } : {};
    if (!wantsRows) { res.writeHead(201); return res.end(); }
    if (accept.includes("vnd.pgrst.object")) {
      if (result.rows.length !== 1) return json(res, 406, { code: "PGRST116", message: "0 or many rows" });
      return json(res, 200, result.rows[0], headers);
    }
    return json(res, 200, result.rows, headers);
  } catch (e) {
    console.log("STUBERR", req.method, url.pathname + url.search, e.code, e.message); return json(res, e.code === "42501" ? 403 : 409, { code: e.code ?? "XX000", message: e.message });
  }
});
await new Promise((r) => stub.listen(54399, "127.0.0.1", r));

// ------------------------------------------------------------- next + chrome
const BASE = "http://127.0.0.1:3100";
const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", "3100", "-H", "127.0.0.1"], {
  cwd: PROJECT,
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54399", NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, PLUGGY_API_URL: "http://127.0.0.1:54400", PLUGGY_CLIENT_ID: "cid", PLUGGY_CLIENT_SECRET: "SEGREDO_PLUGGY_E2E", PLUGGY_ITEM_IDS: "item-1", CRON_SECRET: "cron-secreto", WALLET_SYNC_TOKEN: "wos_token_do_agendador_e2e", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let nextLog = "";
next.stdout.on("data", (d) => (nextLog += d));
next.stderr.on("data", (d) => (nextLog += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 120; i++) {
  try { await fetch(BASE + "/login"); break; } catch { await sleep(1000); }
}

const profile = path.join(OUT, "profile");
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank",
], { stdio: "ignore" });

let target;
for (let i = 0; i < 60 && !target; i++) {
  try { target = (await (await fetch("http://127.0.0.1:9333/json")).json()).find((t) => t.type === "page"); }
  catch { await sleep(500); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map(); const browserErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") browserErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") browserErrors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
};
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Runtime.enable"); await cdp("Page.enable");

const evalJs = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval");
  return r.result?.result?.value;
};
const waitFor = async (expr, label, ms = 45000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await evalJs(expr)) return true; } catch {}
    await sleep(150);
  }
  throw new Error("timeout: " + label + "\nDIALOG: " + (await evalJs("document.querySelector('dialog[open]')?.innerText ?? '(nenhum)'")).slice(0, 900) + "\nTEXTO: " + (await evalJs("document.body.innerText")).slice(0, 300));
};
const goto = async (p) => { await cdp("Page.navigate", { url: BASE + p }); await sleep(300); await waitFor("document.readyState==='complete'", "load " + p); await sleep(700); };
const hasText = (t) => `document.body.innerText.replace(/\u00a0/g," ").toLowerCase().includes(${JSON.stringify(t.toLowerCase())})`;
const scope = `(document.querySelector('dialog[open]') ?? document)`;
const click = async (text) => {
  await waitFor(`[...${scope}.querySelectorAll('button,a,summary')].some(e=>e.innerText.trim()===${JSON.stringify(text)})`, "botão " + text);
  await evalJs(`[...${scope}.querySelectorAll('button,a,summary')].find(e=>e.innerText.trim()===${JSON.stringify(text)}).click()`);
};
const setVal = (sel, val) => evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
  const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(val)});
  e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
const shot = async (name) => {
  await sleep(450);
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.result.data, "base64"));
};
const viewport = (width, height, mobile) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });

let passed = 0; const failures = [];
const check = async (label, fn) => {
  try { const ok = await fn(); if (ok === false) throw new Error("falso"); passed++; console.log("PASS", label); }
  catch (e) { failures.push(label); console.log("FAIL", label, "::", String(e.message).slice(0, 900)); }
};
const see = (t) => waitFor(hasText(t), "texto " + t, 20000);
const notSee = async (t) => !(await evalJs(hasText(t)));
const login = async (email) => {
  await goto("/login");
  await setVal('input[name=email]', email); await setVal('input[name=password]', "senha-forte-123");
  await click("Entrar");
  await waitFor(`location.pathname==='/overview'`, "login");
};
const openNew = async () => click("Nova conta");
const scalar = async (q, p) => Object.values((await db.query(q, p)).rows[0])[0];

const m23 = await import("./transactions-checks.mjs");
const m4 = await import("./cards-capture-checks.mjs");
const helpers = { check, goto, see, notSee, click, setVal, evalJs, waitFor, shot, sleep, db, scalar, viewport, hasText, USERS };

try {
  await viewport(1280, 860, false);

  await check("login e overview vazio com atalho para /financeiro", async () => {
    await login("a@teste.dev");
    await see("Cadastre sua primeira conta");
  });

  await check("estado vazio em /financeiro", async () => {
    await goto("/financeiro");
    await see("Nenhuma conta cadastrada");
    await shot("01-vazio-desktop");
  });

  await check("validação preserva o que foi digitado e mostra erros", async () => {
    await click("Cadastrar primeira conta");
    await waitFor(`!!document.querySelector('dialog[open] input[name=name]')`, "modal");
    await setVal('input[name=institution]', "Nubank");
    await click("Criar conta");
    await see("Informe um nome para a conta.");
    await evalJs(`document.querySelector('input[name=institution]').value==='Nubank'`).then((v) => { if (!v) throw new Error("instituição apagada"); });
    await shot("02-form-erro-desktop");
  });

  await check("valor inválido é recusado pelo servidor", async () => {
    await setVal('input[name=name]', "Principal");
    await setVal('#account-opening', "12,345");
    await click("Criar conta");
    await see("Informe um valor válido");
  });

  await check("criar conta: saldo em centavos, toast e lista sem recarregar", async () => {
    await setVal('#account-opening', "1.234,56");
    await click("Criar conta");
    await see("Conta criada.");
    await see("R$ 1.234,56");
    await waitFor(`!document.querySelector('dialog[open]')`, "modal fechado");
    const stored = await scalar("select balance_cents from public.bank_accounts where name='Principal'");
    if (Number(stored) !== 123456) throw new Error("banco: " + stored);
    await shot("03-lista-desktop");
  });

  await check("audit_logs registra a criação", async () => {
    const n = await scalar("select count(*) from public.audit_logs where event='account.created'");
    if (Number(n) !== 1) throw new Error("n=" + n);
  });

  await check("duplicata na mesma instituição é recusada", async () => {
    await openNew();
    await waitFor(`!!document.querySelector('dialog[open] input[name=name]')`, "modal");
    await setVal('input[name=name]', "principal"); await setVal('input[name=institution]', "NUBANK");
    await click("Criar conta");
    await see("Já existe uma conta ativa");
    await click("Cancelar");
  });

  await check("carteira sem instituição, com saldo negativo pelo seletor de sinal", async () => {
    await openNew();
    await waitFor(`!!document.querySelector('dialog[open] input[name=name]')`, "modal");
    await setVal('input[name=name]', "Carteira");
    await setVal('select[name=kind]', "wallet");
    await see("Instituição (opcional)");
    await setVal('#account-opening', "50,00");
    await evalJs(`document.querySelector('dialog[open] button[aria-pressed]').click()`);
    await sleep(100);
    await click("Criar conta");
    await see("Saldo negativo");
    const row = (await db.query("select balance_cents, institution, kind from public.bank_accounts where name='Carteira'")).rows[0];
    if (Number(row.balance_cents) !== -5000 || row.institution !== null || row.kind !== "wallet") throw new Error(JSON.stringify(row, (_, v) => typeof v === "bigint" ? Number(v) : v));
  });

  await check("saldo total soma as contas ativas (1.184,56)", () => see("R$ 1.184,56"));

  await check("overview reflete o saldo via navegação cliente", async () => {
    await evalJs(`[...document.querySelectorAll('aside a')].find(a=>a.innerText.trim()==='Overview').click()`);
    await waitFor(`location.pathname==='/overview'`, "nav");
    await see("R$ 1.184,56");
    await evalJs(`[...document.querySelectorAll('aside a')].find(a=>a.innerText.trim()==='Financeiro').click()`);
    await waitFor(`location.pathname==='/financeiro'`, "nav");
  });

  const principalId = (await db.query("select id from public.bank_accounts where name='Principal'")).rows[0].id;

  await check("detalhe mostra saldo, inicial, data, e permite excluir sem movimentos", async () => {
    await goto(`/financeiro/contas/${principalId}`);
    await see("Saldo inicial"); await see("Criada em");
    await see("Nenhuma movimentação"); await see("Excluir");
    await shot("04-detalhe-vazio-desktop");
  });

  await check("movimentos aparecem, atualizam saldo e somem com o Excluir", async () => {
    const uid = USERS["a@teste.dev"];
    for (let i = 0; i < 25; i++) {
      await db.query(`insert into public.transactions (user_id,account_id,posted_at,description,amount_cents,kind,dedupe_hash)
        values ($1,$2,$3,$4,$5,$6::public.tx_kind,$7)`,
        [uid, principalId, `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, `Lançamento ${i}`, i === 0 ? 200000 : -1000, i === 0 ? "income" : "debit", `e2e:${i}`]);
    }
    await goto(`/financeiro/contas/${principalId}`);
    await see("R$ 2.994,56"); // 1.234,56 + 2.000,00 - 24 x 10,00
    await see("Movimentações"); await see("Carregar mais");
    if (!(await notSee("Excluir"))) throw new Error("Excluir visível");
    await shot("05-detalhe-movimentos-desktop");
  });

  await check("carregar mais traz as demais movimentações", async () => {
    await evalJs(`(document.querySelectorAll('main ul.divide-y li').length)`).then((n) => { if (n !== 20) throw new Error("n=" + n); });
    await click("Carregar mais");
    await waitFor(`document.querySelectorAll('main ul.divide-y li').length===25`, "25 linhas");
    if (!(await notSee("Carregar mais"))) throw new Error("botão ainda visível");
  });

  await check("editar saldo inicial desloca o saldo atual", async () => {
    await click("Editar");
    await waitFor(`document.querySelector('#account-opening')?.value==='1.234,56'`, "valor pré-preenchido");
    await setVal('#account-opening', "2.234,56");
    await click("Salvar alterações");
    await see("Conta atualizada.");
    await see("R$ 3.994,56");
  });

  await check("arquivar pede confirmação, avisa do saldo e tira do total", async () => {
    await click("Arquivar");
    await see("deixará de contar no seu saldo total");
    await shot("06-confirmar-arquivar-desktop");
    await evalJs(`[...document.querySelector('dialog[open]').querySelectorAll('button')].find(b=>b.innerText.trim()==='Arquivar').click()`);
    await see("Conta arquivada.");
    await see("Arquivada");
    await goto("/financeiro");
    await see("Arquivadas");
    if (await evalJs(`[...document.querySelectorAll('main section')][0].innerText.replace(/\u00a0/g,' ').includes('3.994,56')`)) throw new Error("ainda no total");
    await shot("07-lista-com-arquivada-desktop");
  });

  await check("reativar devolve ao total", async () => {
    await goto(`/financeiro/contas/${principalId}`);
    await click("Reativar");
    await see("Conta reativada.");
    await goto("/financeiro");
    await see("R$ 3.944,56");
  });

  await check("excluir conta sem movimentos: confirma, redireciona, avisa e limpa a URL", async () => {
    const id = (await db.query("select id from public.bank_accounts where name='Carteira'")).rows[0].id;
    await goto(`/financeiro/contas/${id}`);
    await click("Excluir");
    await see("Esta ação é permanente");
    await click("Excluir conta");
    await see("Conta excluída.");
    await waitFor(`location.pathname==='/financeiro' && location.search===''`, "url limpa");
    const n = await scalar("select count(*) from public.bank_accounts where id=$1", [id]);
    if (Number(n) !== 0) throw new Error("não excluiu");
  });

  await check("corrida: conta ganha movimento depois de a tela carregar, e a exclusão é recusada", async () => {
    const uid = USERS["a@teste.dev"];
    const id = (await db.query("insert into public.bank_accounts (user_id,name,kind) values ($1,'Corrida','cash') returning id", [uid])).rows[0].id;
    await goto(`/financeiro/contas/${id}`);
    await see("Excluir");
    await db.query(`insert into public.transactions (user_id,account_id,posted_at,description,amount_cents,dedupe_hash) values ($1,$2,'2026-11-01','x',-1,'e2e:race')`, [uid, id]);
    await click("Excluir");
    await click("Excluir conta");
    await see("tem movimentações e não pode ser excluída");
    const n = await scalar("select count(*) from public.bank_accounts where id=$1", [id]);
    if (Number(n) !== 1) throw new Error("excluiu");
  });

  await check("id inválido na URL responde 404", async () => {
    await goto("/financeiro/contas/nao-e-uuid");
    await waitFor(hasText("404") + " || " + hasText("could not be found"), "404");
  });

  await viewport(390, 844, true);
  await check("celular: lista, folha inferior e detalhe sem rolagem horizontal", async () => {
    await goto("/financeiro");
    await see("Contas ativas");
    await shot("08-lista-mobile");
    const over = await evalJs(`document.documentElement.scrollWidth - window.innerWidth`);
    if (over > 0) throw new Error("overflow lista " + over);
    await openNew();
    await waitFor(`!!document.querySelector('dialog[open] input[name=name]')`, "modal");
    await sleep(500);
    const rect = await evalJs(`(()=>{const r=document.querySelector('dialog[open]').getBoundingClientRect();return {b:Math.round(r.bottom),w:Math.round(r.width)}})()`);
    if (rect.b !== 844 || rect.w !== 390) throw new Error("folha: " + JSON.stringify(rect));
    await shot("09-form-mobile");
    await click("Cancelar");
    await goto(`/financeiro/contas/${principalId}`);
    await see("Saldo atual");
    await shot("10-detalhe-mobile");
    const over2 = await evalJs(`document.documentElement.scrollWidth - window.innerWidth`);
    if (over2 > 0) throw new Error("overflow detalhe " + over2);
  });

  await m23.runA(helpers);
  await m4.runA(helpers);
  await viewport(1280, 860, false);
  await check("logout e usuário B não vê nada de A", async () => {
    await evalJs(`[...document.querySelectorAll('aside button')].find(b=>b.innerText.trim()==='Sair').click()`);
    await waitFor(`location.pathname==='/login'`, "logout");
    await login("b@teste.dev");
    await goto("/financeiro");
    await see("Nenhuma conta cadastrada");
    if (!(await notSee("Principal"))) throw new Error("vazou");
  });

  await check("usuário B recebe 404 na URL da conta de A", async () => {
    await goto(`/financeiro/contas/${principalId}`);
    await waitFor(hasText("404") + " || " + hasText("could not be found"), "404");
    if (!(await notSee("Principal"))) throw new Error("vazou");
  });

  await m23.runB(helpers);
  await m4.runB(helpers);
  await check("sem sessão, /financeiro redireciona para /login", async () => {
    await cdp("Network.clearBrowserCookies");
    await goto("/financeiro");
    await waitFor(`location.pathname==='/login'`, "redirect");
  });

  // Mutação direta do Server Action alheio é coberta pelo RLS: PATCH/DELETE de B em A = 0 linhas.
  await check("API: B não altera nem exclui a conta de A", async () => {
    const tokenB = jwt({ sub: USERS["b@teste.dev"], role: "authenticated" });
    const h = { apikey: ANON, authorization: `Bearer ${tokenB}`, "content-type": "application/json", prefer: "return=representation" };
    const patch = await fetch(`http://127.0.0.1:54399/rest/v1/bank_accounts?id=eq.${principalId}&select=id`, { method: "PATCH", headers: h, body: JSON.stringify({ archived: true }) });
    const del = await fetch(`http://127.0.0.1:54399/rest/v1/bank_accounts?id=eq.${principalId}&select=id`, { method: "DELETE", headers: h });
    if ((await patch.json()).length !== 0 || (await del.json()).length !== 0) throw new Error("afetou");
    const forged = await fetch(`http://127.0.0.1:54399/rest/v1/bank_accounts?id=eq.${principalId}&select=id`, { method: "PATCH", headers: { ...h, authorization: `Bearer ${jwt({ sub: USERS["a@teste.dev"], role: "authenticated" })}` }, body: JSON.stringify({ balance_cents: 1 }) });
    if (forged.status !== 403) throw new Error("dono escreveu balance_cents: " + forged.status);
  });

  await check("invariante do saldo no fim de tudo", async () => {
    const bad = await scalar(`select count(*) from (
      select a.id from public.bank_accounts a left join public.transactions t on t.account_id=a.id
      group by a.id having a.balance_cents <> a.opening_balance_cents + coalesce(sum(t.amount_cents),0)) x`);
    if (Number(bad) !== 0) throw new Error("contas divergentes: " + bad);
  });
} finally {
  console.log(`\nRESULTADO: ${passed} ok, ${failures.length} falhas`);
  failures.forEach((f) => console.log(" - " + f));
  const realErrors = browserErrors.filter((e) => !/404|Failed to load resource/.test(String(e)));
  console.log("Erros no console do navegador:", realErrors.length);
  realErrors.slice(0, 10).forEach((e) => console.log("  ", String(e).slice(0, 400)));
  const serverIssues = nextLog.split("\n").filter((l) => /⨯|\[accounts\.|\[categories\.|\[transactions\.|\[transfers\.|\[list|\[get|\[category|\[audit|Error:/.test(l));
  console.log("Avisos do servidor:", serverIssues.length);
  serverIssues.slice(0, 15).forEach((l) => console.log("  ", l.slice(0, 300)));
  try { ws.close(); } catch {}
  chrome.kill(); next.kill(); stub.close();
  setTimeout(() => process.exit(failures.length ? 1 : 0), 800);
}
