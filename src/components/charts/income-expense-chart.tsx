import { formatBRL } from "@/lib/utils";

type Point = { label: string; incomeCents: number; expenseCents: number };

/** Gráfico de barras minimalista em SVG puro (sem dependências). */
export function IncomeExpenseChart({ data }: { data: Point[] }) {
  const W = 600;
  const H = 220;
  const padX = 12;
  const baseY = H - 28;
  const topY = 12;
  const max = Math.max(1, ...data.flatMap((d) => [d.incomeCents, d.expenseCents]));
  const slot = (W - padX * 2) / data.length;
  const barW = Math.min(22, slot / 3);
  const h = (v: number) => ((baseY - topY) * v) / max;

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Receitas e despesas dos últimos meses"
      >
        <line x1={padX} x2={W - padX} y1={baseY} y2={baseY} stroke="#1f1f1f" />
        {data.map((d, i) => {
          const cx = padX + slot * i + slot / 2;
          return (
            <g key={d.label}>
              <title>
                {`${d.label}: receitas ${formatBRL(d.incomeCents)} · despesas ${formatBRL(d.expenseCents)}`}
              </title>
              <rect
                x={cx - barW - 2}
                y={baseY - h(d.incomeCents)}
                width={barW}
                height={h(d.incomeCents)}
                rx={4}
                fill="#fafafa"
              />
              <rect
                x={cx + 2}
                y={baseY - h(d.expenseCents)}
                width={barW}
                height={h(d.expenseCents)}
                rx={4}
                fill="#4a4a4a"
              />
              <text
                x={cx}
                y={H - 8}
                textAnchor="middle"
                fontSize="12"
                fill="#8c8c8c"
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex items-center gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-fg" /> Receitas
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#4a4a4a]" /> Despesas
        </span>
      </figcaption>
    </figure>
  );
}
