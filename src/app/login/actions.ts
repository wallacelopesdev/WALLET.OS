"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error?: string };

const credentials = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
});

export async function signIn(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  if (!isSupabaseConfigured()) {
    return { error: "Supabase não configurado. Use o modo demonstração." };
  }

  const parsed = credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "Informe um e-mail e uma senha válidos." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);

  // Mensagem genérica: não revela se o e-mail existe.
  if (error || !data.user) {
    return { error: "E-mail ou senha inválidos." };
  }

  const h = await headers();
  await supabase.from("audit_logs").insert({
    user_id: data.user.id,
    event: "auth.login",
    user_agent: h.get("user-agent")?.slice(0, 300) ?? null,
  });

  redirect("/overview");
}

export async function signOut() {
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from("audit_logs")
        .insert({ user_id: user.id, event: "auth.logout" });
    }
    await supabase.auth.signOut();
  }
  redirect("/login");
}
