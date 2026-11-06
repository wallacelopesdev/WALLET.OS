import { cn, formatBRL, formatDateFull } from "@/lib/utils";
import { MOVEMENT_KIND_LABELS } from "../constants";
import type { Movement } from "../queries";

export function MovementsList({ movements }: { movements: Movement[] }) {
  return (
    <ul className="mt-2 divide-y divide-line">
      {movements.map((m) => (
        <li key={m.id} className="flex items-start justify-between gap-4 py-3.5">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{m.description}</p>
            <p className="mt-0.5 text-xs text-faint">
              {[
                formatDateFull(m.postedAt),
                MOVEMENT_KIND_LABELS[m.kind] ?? "Outros",
                m.categoryName,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <p
            className={cn(
              "shrink-0 text-sm tabular-nums",
              m.amountCents > 0 && "text-positive",
            )}
          >
            {m.amountCents > 0 ? "+" : ""}
            {formatBRL(m.amountCents)}
          </p>
        </li>
      ))}
    </ul>
  );
}
