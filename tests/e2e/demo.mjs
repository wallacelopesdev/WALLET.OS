// Modo demonstração: sem Supabase, telas abrem, marcam dados fictícios e não oferecem escrita.
import { spawn } from "node:child_process";

const PROJECT = process.cwd();
const BASE = "http://127.0.0.1:3101";
const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "", NEXT_TELEMETRY_DISABLED: "1" };
const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", "3101", "-H", "127.0.0.1"], { cwd: PROJECT, env, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 120; i++) {
  try { await fetch(BASE + "/login"); break; } catch { await sleep(1000); }
}

const norm = (s) => s.replace(/ /g, " ");
const pages = [
  ["/overview", ["Dados fictícios"], []],
  ["/financeiro", ["Dados fictícios", "Conta Demo", "Categorias"], ["Nova conta"]],
  ["/financeiro/contas/demo-corrente", ["Dados fictícios", "Exemplo de mercado", "Saldo atual"], ["Editar", "Arquivar", "Excluir", "Editar ou lançar"]],
  ["/financeiro/categorias", ["Dados fictícios", "Moradia", "Salário"], ["Nova categoria"]],
  ["/cartoes", ["Demo A", "Limite"], ["Novo cart"]],
  ["/cartoes/demo-card-a", ["Demo A", "Fatura atual"], ["Nova compra", "Editar"]],
  ["/cartoes/demo-card-a/faturas/demo-invoice-10", ["Exemplo de compra"], ["Pagar fatura"]],
  ["/configuracoes/captura", ["modo demonstra"], ["Criar token"]],
  ["/transacoes", ["Dados fictícios", "Exemplo de salário", "Exemplo de aluguel"], ["Novo lançamento", "Pesquisar"]],
];
let failures = 0;
for (const [path, must, mustNot] of pages) {
  const res = await fetch(BASE + path);
  const html = norm(await res.text());
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, " ");
  const problems = [
    res.status !== 200 && `status ${res.status}`,
    ...must.filter((t) => !html.includes(t)).map((t) => `sem "${t}"`),
    ...mustNot.filter((t) => visible.includes(`>${t}<`)).map((t) => `com "${t}"`),
  ].filter(Boolean);
  console.log(problems.length ? "FAIL" : "PASS", path, problems.join(", "));
  failures += problems.length;
}
next.kill();
setTimeout(() => process.exit(failures ? 1 : 0), 500);
