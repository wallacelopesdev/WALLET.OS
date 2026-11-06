import { describe, expect, it } from "vitest";
import {
  categoryFormSchema,
  findDuplicateCategory,
  slugify,
  uniqueSlug,
} from "@/features/categories/schema";

const valid = { name: "Viagens", kind: "expense", icon: "plane", color: "#60a5fa" };

describe("categoryFormSchema", () => {
  it("aceita dados válidos e remove espaços", () => {
    expect(categoryFormSchema.parse({ ...valid, name: "  Viagens " }).name).toBe("Viagens");
  });

  it("exige nome e limita o tamanho", () => {
    expect(categoryFormSchema.safeParse({ ...valid, name: "  " }).success).toBe(false);
    expect(categoryFormSchema.safeParse({ ...valid, name: "x".repeat(60) }).success).toBe(true);
    expect(categoryFormSchema.safeParse({ ...valid, name: "x".repeat(61) }).success).toBe(false);
  });

  it.each([
    ["kind", "transfer"],
    ["icon", "<script>"],
    ["icon", "nao-existe"],
    ["color", "red"],
    ["color", "#123456"],
  ])("rejeita %s = %j", (field, value) => {
    expect(categoryFormSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });

  it("descarta campos que o cliente não pode definir", () => {
    const parsed = categoryFormSchema.parse({ ...valid, is_system: true, user_id: "x" });
    expect(parsed).not.toHaveProperty("is_system");
    expect(parsed).not.toHaveProperty("user_id");
  });
});

describe("slugify", () => {
  it.each([
    ["Alimentação Fora", "alimentacao-fora"],
    ["  Saúde & Bem-estar! ", "saude-bem-estar"],
    ["Café", "cafe"],
    ["🎮", "categoria"],
    ["", "categoria"],
  ])("%j vira %j", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it("limita o tamanho sem deixar hífen no fim", () => {
    const slug = slugify(`${"a".repeat(49)} bbb`);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("uniqueSlug", () => {
  it("usa o slug base quando está livre", () => {
    expect(uniqueSlug("Viagens", ["lazer"])).toBe("viagens");
  });

  it("acrescenta sufixo quando está ocupado", () => {
    expect(uniqueSlug("Viagens", ["viagens"])).toBe("viagens-2");
    expect(uniqueSlug("Viagens", ["viagens", "viagens-2"])).toBe("viagens-3");
  });
});

describe("findDuplicateCategory", () => {
  const existing = [
    { id: "1", name: "Lazer", kind: "expense", archived: false },
    { id: "2", name: "Investimentos", kind: "income", archived: false },
    { id: "3", name: "Antiga", kind: "expense", archived: true },
  ] as const;

  it("ignora maiúsculas e espaços", () => {
    expect(findDuplicateCategory({ name: " LAZER ", kind: "expense" }, existing)?.id).toBe("1");
  });

  it("permite o mesmo nome no outro tipo", () => {
    expect(findDuplicateCategory({ name: "Investimentos", kind: "expense" }, existing)).toBeUndefined();
  });

  it("permite reaproveitar o nome de uma arquivada", () => {
    expect(findDuplicateCategory({ name: "Antiga", kind: "expense" }, existing)).toBeUndefined();
  });

  it("não acusa a própria categoria ao editar", () => {
    expect(findDuplicateCategory({ name: "Lazer", kind: "expense" }, existing, "1")).toBeUndefined();
  });
});
