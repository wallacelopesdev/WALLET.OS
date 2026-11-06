import { cn, formatPercent } from "@/lib/utils";
import { Card, CardTitle } from "./card";

type Props = {
  label: string;
  value: string;
  hint?: string;
  /** Variação percentual vs. mês anterior. */
  delta?: number | null;
  /** Se true, queda é a boa notícia (ex.: despesas). */
  lowerIsBetter?: boolean;
};

export function StatCard({ label, value, hint, delta, lowerIsBetter }: Props) {
  const hasDelta = typeof delta === "number" && Number.isFinite(delta);
  const good = hasDelta && (lowerIsBetter ? delta! <= 0 : delta! >= 0);

  return (
    <Card className="animate-rise">
      <CardTitle>{label}</CardTitle>
      <p className="mt-3 text-2xl font-semibold tabular-nums tracking-tight md:text-3xl">
        {value}
      </p>
      <div className="mt-2 flex items-center gap-2 text-xs">
        {hasDelta && (
          <span
            className={cn(
              "tabular-nums font-medium",
              good ? "text-positive" : "text-muted",
            )}
          >
            {delta! > 0 ? "+" : ""}
            {formatPercent(delta!, 1)}
          </span>
        )}
        {hint && <span className="text-faint">{hint}</span>}
      </div>
    </Card>
  );
}
