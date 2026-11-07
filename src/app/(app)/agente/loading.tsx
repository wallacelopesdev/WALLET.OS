import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Carregando">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Card className="mt-3 space-y-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex justify-between gap-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </Card>
    </div>
  );
}
