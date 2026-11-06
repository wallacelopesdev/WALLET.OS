"use client";

import { Card } from "@/components/ui/card";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Card className="mx-auto mt-12 max-w-md text-center">
      <h1 className="text-lg font-semibold">Algo deu errado</h1>
      <p className="mt-2 text-sm text-muted">
        Não foi possível carregar esta página.
        {error.digest ? ` (ref: ${error.digest})` : ""}
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-5 rounded-xl bg-fg px-5 py-2.5 text-sm font-medium text-ink transition-opacity hover:opacity-90"
      >
        Tentar novamente
      </button>
    </Card>
  );
}
