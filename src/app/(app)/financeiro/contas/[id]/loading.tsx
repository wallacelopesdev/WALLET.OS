import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Carregando conta">
      <Skeleton className="mb-6 h-5 w-20" />
      <div className="mb-6 flex items-center gap-3">
        <Skeleton className="h-12 w-12 rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-5">
        <Skeleton className="h-44 rounded-2xl lg:col-span-3" />
        <Skeleton className="h-44 rounded-2xl lg:col-span-2" />
      </div>
      <Card className="mt-3 space-y-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex justify-between gap-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </Card>
    </div>
  );
}
