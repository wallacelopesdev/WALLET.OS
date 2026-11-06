"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signIn, type LoginState } from "./actions";

const field =
  "w-full rounded-xl border border-line-strong bg-surface px-4 py-3 text-fg placeholder:text-faint outline-none transition-colors focus:border-fg";

export function LoginForm({ demo }: { demo: boolean }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(
    signIn,
    {},
  );

  if (demo) {
    return (
      <div className="mt-8 space-y-4">
        <div className="rounded-xl border border-line-strong bg-surface p-4 text-sm text-muted">
          <p className="font-medium text-fg">Modo demonstração</p>
          <p className="mt-1">
            O Supabase ainda não está configurado. Os dados exibidos são
            fictícios e nada é salvo. Configure o <code>.env.local</code> para
            ativar o login real.
          </p>
        </div>
        <Link
          href="/overview"
          className="block w-full rounded-xl bg-fg py-3 text-center font-medium text-ink transition-opacity hover:opacity-90 active:opacity-80"
        >
          Entrar em modo demonstração
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="mt-8 space-y-3">
      <label className="block">
        <span className="sr-only">E-mail</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="E-mail"
          required
          className={field}
        />
      </label>
      <label className="block">
        <span className="sr-only">Senha</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="Senha"
          required
          minLength={8}
          className={field}
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-muted">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-xl bg-fg py-3 font-medium text-ink transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-50"
      >
        {pending ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
