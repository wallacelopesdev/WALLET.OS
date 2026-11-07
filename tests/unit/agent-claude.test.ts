import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askClaude } from "@/features/agent/chat/claude";

type Body = {
  model: string;
  system: string;
  tools: { name: string }[];
  messages: { role: string; content: unknown }[];
  fallbacks?: unknown;
};

const usage = { input_tokens: 1, output_tokens: 1 };

const message = (content: unknown[], stopReason: string) =>
  new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const toolCall = (input: unknown) =>
  message([{ type: "tool_use", id: "tu_1", name: "consultar_financas", input }], "tool_use");

/** Sem rede: responde em sequência e guarda o que o SDK enviou. */
function fakeApi(responses: Response[]) {
  const bodies: Body[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (!next) throw new Error("chamada inesperada");
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return bodies;
}

const answer = { text: "Você gastou R$ 10,00.", period: "este mês", source: "Transações", rows: [] };

describe("camada opcional com a Claude API", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "chave-de-teste");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("só oferece uma ferramenta, de leitura, e devolve a resposta com os dados consultados", async () => {
    const bodies = fakeApi([
      toolCall({ consulta: "spent", de: "2026-11-01", ate: "2026-11-05", categoria: null }),
      message([{ type: "text", text: "Você gastou R$ 10,00 este mês." }], "end_turn"),
    ]);
    const query = vi.fn(async () => answer);

    const text = await askClaude("Dá para resumir meus gastos?", "2026-11-05", query);

    expect(text).toBe("Você gastou R$ 10,00 este mês.");
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]).toEqual([
      "spent",
      { from: "2026-11-01", to: "2026-11-05", label: "2026-11-01 a 2026-11-05" },
      null,
    ]);
    expect(bodies[0].tools.map((t) => t.name)).toEqual(["consultar_financas"]);
    expect(bodies[0].model).toBe("claude-opus-5-5");
    expect(bodies[0].fallbacks).toBe("default");
    expect(JSON.stringify(bodies[1].messages)).toContain("R$ 10,00");
  });

  it("recusa consulta inválida sem tocar nos dados", async () => {
    const bodies = fakeApi([
      toolCall({ consulta: "transferir_dinheiro", de: "2026-11-01", ate: "2026-11-05", categoria: null }),
      message([{ type: "text", text: "Não consigo fazer isso." }], "end_turn"),
    ]);
    const query = vi.fn(async () => answer);

    await askClaude("Transfira 100 reais", "2026-11-05", query);

    expect(query).not.toHaveBeenCalled();
    expect(JSON.stringify(bodies[1].messages)).toContain("Consulta inválida");
  });

  it("recusa período invertido ou data malformada", async () => {
    fakeApi([
      toolCall({ consulta: "spent", de: "2026-12-01", ate: "2026-11-01", categoria: null }),
      message([{ type: "text", text: "Período inválido." }], "end_turn"),
    ]);
    const query = vi.fn(async () => answer);
    await askClaude("Gastos?", "2026-11-05", query);
    expect(query).not.toHaveBeenCalled();
  });

  it("recusa do modelo não vira resposta", async () => {
    fakeApi([message([], "refusal")]);
    expect(await askClaude("?", "2026-11-05", vi.fn(async () => answer))).toBeNull();
  });
});
