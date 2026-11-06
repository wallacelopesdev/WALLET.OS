import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Carregando">
      <Skeleton className="mb-6 h-5 w-24" />
      <Skeleton className="mb-6 h-9 w-56" />
      <div className="grid gap-3 lg:grid-cols-5">
        <Skeleton className="h-52 rounded-2xl lg:col-span-3" />
        <Skeleton className="h-52 rounded-2xl lg:col-span-2" />
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
