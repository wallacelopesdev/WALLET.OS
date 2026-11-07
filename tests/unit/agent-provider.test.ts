import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mapItemHealth } from "@/features/agent/providers/pluggy";
import { inferBankDetails } from "@/features/agent/providers/pluggy-map";

describe("estado de uma conexão", () => {
  it("atualizada e sem erro é ativa", () => {
    expect(
      mapItemHealth({ status: "UPDATED", connector: { name: "Itaú" }, consentExpiresAt: "2027-01-01T00:00:00.000Z" }),
    ).toEqual({ status: "active", institution: "Itaú", consentExpiresAt: "2027-01-01T00:00:00.000Z", errorCode: null });
  });

  it("atualizando não é falha", () => {
    expect(mapItemHealth({ status: "UPDATING" }).status).toBe("active");
  });

  it("erro de login significa autorização encerrada", () => {
    expect(mapItemHealth({ status: "LOGIN_ERROR" })).toMatchObject({ status: "expired", errorCode: "LOGIN_ERROR" });
  });

  it("desatualizada e aguardando o usuário são falhas, não vencimento", () => {
    expect(mapItemHealth({ status: "OUTDATED" })).toMatchObject({ status: "error", errorCode: "OUTDATED" });
    expect(mapItemHealth({ status: "WAITING_USER_INPUT" }).status).toBe("error");
  });

  it("autorização expirada no erro do item", () => {
    expect(mapItemHealth({ status: "OUTDATED", error: { code: "USER_AUTHORIZATION_EXPIRED" } }).status).toBe("expired");
  });
});

describe("linha de extrato sem tipo informado", () => {
  it("pagamento de fatura nunca vira despesa comum", () => {
    expect(inferBankDetails("PAGAMENTO FATURA NUBANK", false).intent).toBe("invoice_payment");
  });

  it("entrada com texto de estorno é estorno", () => {
    expect(inferBankDetails("ESTORNO COMPRA LOJA", true).intent).toBe("refund");
  });

  it("Pix e boleto são reconhecidos", () => {
    expect(inferBankDetails("PIX ENVIADO JOAO", false)).toEqual({ method: "pix", intent: "normal" });
    expect(inferBankDetails("PAGTO BOLETO ENERGIA", false).method).toBe("boleto");
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Garantias de segurança verificadas sobre o próprio código, para não regredirem em silêncio. */
describe("o agente não consegue movimentar dinheiro", () => {
  const root = process.cwd();
  const files = [
    ...sourceFiles(path.join(root, "src/features/agent")),
    ...sourceFiles(path.join(root, "src/app/api/cron")),
    ...sourceFiles(path.join(root, "src/app/api/webhooks")),
    ...sourceFiles(path.join(root, "src/app/api/capture")),
  ];
  const read = (file: string) => readFileSync(file, "utf8");

  it("encontrou os arquivos do agente", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("o provedor só usa os endereços de leitura e o de autenticação", () => {
    const source = read(path.join(root, "src/features/agent/providers/pluggy.ts"));
    const paths = [...source.matchAll(/[`"](\/[a-z0-9/_-]*)/gi)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(["/auth", "/accounts", "/v2/transactions", "/items/"]).toContain(p);
    }
  });

  it("não há chamadas às APIs de pagamento da Pluggy nem a Pix", () => {
    const forbidden = /payment[-_]?(request|intent|initiation|recipient)|smart-?transfer|bulk-?payment|\/payments?\b|pix\/(send|transfer)/i;
    for (const file of files) {
      expect(forbidden.test(read(file)), file).toBe(false);
    }
  });

  it("nada usa a service role, que ignoraria o isolamento entre usuários", () => {
    for (const file of files) {
      expect(read(file).includes("SERVICE_ROLE"), file).toBe(false);
    }
  });

  it("a IA só tem uma ferramenta, de consulta", () => {
    const source = read(path.join(root, "src/features/agent/chat/claude.ts"));
    expect(source.match(/betaTool\(\{/g)).toHaveLength(1);
    expect(source).toContain("tools: [consult]");
    expect(source).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
  });

  it("as respostas da conversa só leem dados", () => {
    const source = read(path.join(root, "src/features/agent/chat/answers.ts"));
    expect(source).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
  });
});
