import type { Metadata } from "next";
import { isSupabaseConfigured } from "@/lib/env";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <div className="animate-rise">
        <p className="text-xs font-medium uppercase tracking-[0.3em] text-muted">
          Personal Operating System
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">WALLET OS</h1>
        <p className="mt-2 text-sm text-muted">
          Acesso privado. Entre com sua conta.
        </p>
        <LoginForm demo={!isSupabaseConfigured()} />
      </div>
    </main>
  );
}
