/**
 * Skeleton for `/resources`: heading, toolbar, and a card grid matching the
 * library layout so the first real rows land without a jump.
 */
export default function ResourcesLoading() {
  return (
    <div
      className="flex flex-col gap-6 animate-pulse"
      aria-busy="true"
      aria-label="Loading resources"
    >
      <div className="flex flex-col gap-2">
        <div className="h-8 w-44 rounded-md bg-muted" />
        <div className="h-4 w-72 max-w-full rounded bg-muted" />
      </div>
      <div className="h-11 w-full rounded-md bg-muted" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={index}
            className="h-40 rounded-xl border bg-card p-4 shadow-sm"
          >
            <div className="flex flex-col gap-3">
              <div className="h-5 w-3/4 rounded bg-muted" />
              <div className="h-4 w-1/2 rounded bg-muted" />
              <div className="h-4 w-2/3 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
