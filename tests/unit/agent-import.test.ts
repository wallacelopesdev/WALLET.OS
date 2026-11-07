import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, parseDecimalToCents, parseStatementDate, splitLine } from "@/features/agent/import/csv";
import { decodeStatement } from "@/features/agent/import/decode";
import { parseOfx } from "@/features/agent/import/ofx";
import { parseStatement } from "@/features/agent/import/parse";

const utf8 = (text: string) => new TextEncoder().encode(text);

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261105120000[-3:BRT]
<TRNAMT>-123.45
<FITID>abc1
<MEMO>COMPRA PADARIA &amp; CAFE
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261106
<TRNAMT>2000.00
<FITID>abc2
<NAME>SALARIO
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const OFX_XML = `<?xml version="1.0"?><OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261105</DTPOSTED><TRNAMT>-10.50</TRNAMT><FITID>x1</FITID><MEMO>LOJA</MEMO></STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

describe("OFX", () => {
  it("lê SGML sem tags de fechamento, com a data e o identificador do banco", () => {
    const result = parseOfx(OFX_SGML);
    expect(result).toMatchObject({
      ok: true,
      format: "ofx",
      skipped: 0,
      rows: [
        { ref: "ofx:abc1", date: "2026-11-05", description: "COMPRA PADARIA & CAFE", amountCents: -12345 },
        { ref: "ofx:abc2", date: "2026-11-06", description: "SALARIO", amountCents: 200000 },
      ],
    });
  });

  it("lê XML de cartão", () => {
    const result = parseOfx(OFX_XML);
    expect(result).toMatchObject({ ok: true, rows: [{ ref: "ofx:x1", amountCents: -1050 }] });
  });

  it("FITID repetido não descarta lançamentos", () => {
    const repeated = `<OFX><BANKTRANLIST>
<STMTTRN><DTPOSTED>20261105<TRNAMT>-5.00<FITID>0<MEMO>A
<STMTTRN><DTPOSTED>20261105<TRNAMT>-7.00<FITID>0<MEMO>B
</BANKTRANLIST></OFX>`;
    const result = parseOfx(repeated);
    expect(result.ok && result.rows.map((r) => r.amountCents).sort()).toEqual([-500, -700]);
    expect(result.ok && new Set(result.rows.map((r) => r.ref)).size).toBe(2);
  });

  it("conta linhas inválidas sem interromper", () => {
    const partial = `<OFX><BANKTRANLIST>
<STMTTRN><DTPOSTED>20261399<TRNAMT>-5.00<FITID>1<MEMO>Data ruim
<STMTTRN><DTPOSTED>20261105<TRNAMT>abc<FITID>2<MEMO>Valor ruim
<STMTTRN><DTPOSTED>20261105<TRNAMT>-5.00<FITID>3<MEMO>Certa
</BANKTRANLIST></OFX>`;
    expect(parseOfx(partial)).toMatchObject({ ok: true, skipped: 2, rows: [{ ref: "ofx:3" }] });
  });

  it("recusa conteúdo que não é OFX", () => {
    expect(parseOfx("<html><body>oi</body></html>").ok).toBe(false);
    expect(parseOfx("<OFX></OFX>").ok).toBe(false);
  });
});

describe("parseDecimalToCents", () => {
  it.each([
    ["1.234,56", 123456],
    ["1,234.56", 123456],
    ["1234,56", 123456],
    ["1234.56", 123456],
    ["-10.5", -1050],
    ["10,5", 1050],
    ["R$ 1.000,00", 100000],
    ["-R$ 25,90", -2590],
    ["(10,00)", -1000],
    ["10,00-", -1000],
    ["100,00 D", -10000],
    ["100,00 C", 10000],
    ["1.234", 123400],
    ["0,00", 0],
    ["19.99", 1999],
  ])("%j vira %i", (input, cents) => {
    expect(parseDecimalToCents(input)).toBe(cents);
  });

  it.each(["", "abc", "12,34,", "1e5", "99999999999999"])("rejeita %j", (input) => {
    expect(parseDecimalToCents(input)).toBeNull();
  });
});

describe("parseStatementDate", () => {
  it.each([
    ["05/11/2026", "2026-11-05"],
    ["5/1/2026", "2026-01-05"],
    ["05-11-26", "2026-11-05"],
    ["05.11.2026", "2026-11-05"],
    ["2026-11-05", "2026-11-05"],
    ["2026-11-05T10:00:00Z", "2026-11-05"],
    ["05/11/2026 10:30", "2026-11-05"],
  ])("%j vira %j", (input, expected) => {
    expect(parseStatementDate(input)).toBe(expected);
  });

  it.each(["31/02/2026", "13/13/2026", "ontem", ""])("rejeita %j", (input) => {
    expect(parseStatementDate(input)).toBeNull();
  });
});

describe("CSV", () => {
  it("respeita aspas e aspas duplicadas", () => {
    expect(splitLine('"Mercado; Central";"Ele disse ""oi""";10,00', ";")).toEqual([
      "Mercado; Central",
      'Ele disse "oi"',
      "10,00",
    ]);
  });

  it.each([
    ["Data;Descrição;Valor\n01/11/2026;Loja;10,00", ";"],
    ["Date,Description,Amount\n2026-11-01,Loja,10.00", ","],
    ["Data\tDescrição\tValor\n01/11/2026\tLoja\t10,00", "\t"],
    ["Data|Descrição|Valor\n01/11/2026|Loja|10,00", "|"],
  ])("detecta o separador de %j", (text, delimiter) => {
    expect(detectDelimiter(text.split("\n"))).toBe(delimiter);
    expect(parseCsv(text)).toMatchObject({ ok: true, rows: [{ description: "Loja" }] });
  });

  it("vírgula decimal entre aspas não confunde o separador", () => {
    const result = parseCsv('Data,Descrição,Valor\n01/11/2026,Loja,"1.234,56"\n02/11/2026,Outra,"-10,00"');
    expect(result).toMatchObject({
      ok: true,
      rows: [{ amountCents: 123456 }, { amountCents: -1000 }],
    });
  });

  it("encontra o cabeçalho depois de títulos do banco", () => {
    const result = parseCsv(
      "Extrato da conta\nAgência 1234;Conta 5678\n\nData;Histórico;Valor\n01/11/2026;Pix;-5,00",
    );
    expect(result).toMatchObject({ ok: true, rows: [{ description: "Pix", amountCents: -500 }] });
  });

  it("colunas separadas de crédito e débito", () => {
    const result = parseCsv(
      "Data;Histórico;Crédito;Débito\n01/11/2026;Salário;2.000,00;\n02/11/2026;Aluguel;;1.500,00",
    );
    expect(result).toMatchObject({
      ok: true,
      rows: [{ amountCents: 200000 }, { amountCents: -150000 }],
    });
  });

  it("ignora linhas de saldo e totais, contando-as", () => {
    const result = parseCsv(
      "Data;Descrição;Valor\n01/11/2026;Saldo anterior;100,00\n01/11/2026;Loja;-5,00\n;Total;95,00",
    );
    expect(result).toMatchObject({ ok: true, skipped: 2, rows: [{ description: "Loja" }] });
  });

  it("duas compras idênticas continuam duas, com identificadores estáveis", () => {
    const text = "Data;Descrição;Valor\n01/11/2026;Café;-5,00\n01/11/2026;Café;-5,00";
    const first = parseCsv(text);
    const second = parseCsv(text);
    expect(first.ok && first.rows).toHaveLength(2);
    expect(first.ok && new Set(first.rows.map((r) => r.ref)).size).toBe(2);
    expect(first.ok && first.rows.map((r) => r.ref)).toEqual(second.ok && second.rows.map((r) => r.ref));
  });

  it.each([
    ["sem cabeçalho reconhecível", "a;b;c\n1;2;3"],
    ["sem colunas", "só uma linha de texto\noutra linha"],
    ["sem movimentações válidas", "Data;Descrição;Valor\nxx;yy;zz"],
    ["vazio", ""],
  ])("recusa arquivo %s", (_label, text) => {
    expect(parseCsv(text).ok).toBe(false);
  });
});

describe("decodeStatement", () => {
  it("UTF-8 com e sem BOM", () => {
    expect(decodeStatement(utf8("Descrição"))).toBe("Descrição");
    expect(decodeStatement(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("Ação")]))).toBe("Ação");
  });

  it("Windows-1252, comum em bancos brasileiros", () => {
    expect(decodeStatement(new Uint8Array([0x41, 0xe7, 0xe3, 0x6f]))).toBe("Ação");
  });

  it("UTF-16 com BOM", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x4f, 0x00, 0x69, 0x00]);
    expect(decodeStatement(bytes)).toBe("Oi");
  });

  it("recusa binário e arquivo vazio", () => {
    expect(decodeStatement(new Uint8Array([0x25, 0x50, 0x00, 0x44]))).toBeNull();
    expect(decodeStatement(new Uint8Array())).toBeNull();
  });
});

describe("parseStatement", () => {
  it("o formato vem do conteúdo, não da extensão", () => {
    expect(parseStatement("extrato.txt", utf8(OFX_SGML))).toMatchObject({ ok: true, format: "ofx" });
    expect(parseStatement("extrato.csv", utf8("Data;Descrição;Valor\n01/11/2026;Loja;1,00"))).toMatchObject({
      ok: true,
      format: "csv",
    });
  });

  it("extensão OFX com outro conteúdo é recusada", () => {
    expect(parseStatement("extrato.ofx", utf8("Data;Descrição;Valor\n01/11/2026;Loja;1,00")).ok).toBe(false);
  });

  it("recusa extensão desconhecida, binário disfarçado e arquivo grande", () => {
    expect(parseStatement("virus.exe", utf8(OFX_SGML)).ok).toBe(false);
    expect(parseStatement("foto.csv", new Uint8Array([0xff, 0xd8, 0x00, 0x10])).ok).toBe(false);
    expect(parseStatement("grande.csv", new Uint8Array(5 * 1024 * 1024 + 1)).ok).toBe(false);
  });
});
