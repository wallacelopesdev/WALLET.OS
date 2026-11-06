import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Carregando transações">
      <div className="mb-8">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="mt-3 h-5 w-72 max-w-full" />
      </div>
      <Skeleton className="mb-3 h-12 rounded-xl" />
      <Card className="space-y-5">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </Card>
    </div>
  );
}
