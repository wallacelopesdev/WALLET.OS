import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Carregando cartões">
      <div className="mb-8">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="mt-3 h-5 w-64 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
      </div>
      <Card className="mt-3 space-y-6">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-3">
            <div className="flex justify-between gap-4">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-20" />
            </div>
            <Skeleton className="h-1.5" />
          </div>
        ))}
      </Card>
    </div>
  );
}
