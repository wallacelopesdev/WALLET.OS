import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export type SessionInfo = { email: string | null; demo: boolean };

export async function getSessionInfo(): Promise<SessionInfo> {
  if (!isSupabaseConfigured()) return { email: null, demo: true };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { email: user?.email ?? null, demo: false };
}
