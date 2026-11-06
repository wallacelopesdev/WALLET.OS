import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createTokenClient } from "@/features/capture/ingest";
import { pluggyEnv, syncPluggy } from "@/features/capture/pluggy";

function matches(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Sincronização diária, disparada pelo agendador da Vercel (vercel.json). */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET ?? "";
  const received = request.headers.get("authorization") ?? "";
  if (!secret || !matches(received, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }

  const env = pluggyEnv();
  const token = process.env.WALLET_SYNC_TOKEN ?? "";
  if (!env || !token) {
    return NextResponse.json({ error: "Pluggy não configurada" }, { status: 503 });
  }

  try {
    const summary = await syncPluggy(createTokenClient(), env, token);
    return NextResponse.json(summary);
  } catch (error) {
    console.error(`[pluggy] ${error instanceof Error ? error.message : "falha"}`);
    return NextResponse.json({ error: "falha na sincronização" }, { status: 502 });
  }
}
