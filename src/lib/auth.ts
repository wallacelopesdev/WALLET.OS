import type { User } from "@supabase/supabase-js";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createClient>>;

export type AuthContext =
  | { ok: true; supabase: Client; user: User }
  | { ok: false; error: string };

/**
 * Porta de entrada de toda escrita: valida a sessão no servidor do Supabase
 * e bloqueia gravações em modo demonstração.
 */
export async function requireUser(): Promise<AuthContext> {
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Modo demonstração: nada é salvo." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "Sua sessão expirou. Entre novamente." };
  }

  return { ok: true, supabase, user };
}
