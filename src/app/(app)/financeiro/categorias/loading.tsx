import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Carregando categorias">
      <div className="mb-8">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="mt-3 h-5 w-72 max-w-full" />
      </div>
      <Skeleton className="mb-4 h-11 w-48" />
      <Skeleton className="mx-auto mb-3 h-11 w-40" />
      <div className="grid gap-3 lg:grid-cols-2">
        {[0, 1].map((column) => (
          <Card key={column} className="space-y-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-xl" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </Card>
        ))}
      </div>
    </div>
  );
}
