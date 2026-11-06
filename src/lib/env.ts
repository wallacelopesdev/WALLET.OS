export function supabaseEnv() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  };
}

export function hasSupabaseEnv(): boolean {
  const { url, anonKey } = supabaseEnv();
  return Boolean(url || anonKey);
}

function isPublicSupabaseKey(key: string): boolean {
  if (key.startsWith("sb_publishable_")) return true;

  const payload = key.split(".")[1];
  if (!payload) return false;

  try {
    const claims = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { role?: unknown };
    return claims.role === "anon";
  } catch {
    return false;
  }
}

/**
 * Sem credenciais do Supabase o app roda em modo demonstração (somente em
 * desenvolvimento). Credenciais parciais, placeholders e chaves privadas
 * nunca habilitam a conexão.
 */
export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = supabaseEnv();
  if (!url || !isPublicSupabaseKey(anonKey)) return false;

  try {
    const parsedUrl = new URL(url);
    const isLocal =
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1" ||
      parsedUrl.hostname === "[::1]";
    return (
      (parsedUrl.protocol === "https:" ||
        (parsedUrl.protocol === "http:" && isLocal)) &&
      !parsedUrl.username &&
      !parsedUrl.password
    );
  } catch {
    return false;
  }
}
