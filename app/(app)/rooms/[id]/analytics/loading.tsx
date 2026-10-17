/**
 * Loading boundary for `/rooms/[id]/analytics`: the page runs the room's
 * aggregate RPC while rendering, so the first paint waits here.
 */
export default function RoomAnalyticsLoading() {
  return (
    <section className="flex flex-col gap-4" aria-busy="true">
      <div className="h-8 w-56 animate-pulse rounded bg-accent" />
      <div className="h-4 w-96 max-w-full animate-pulse rounded bg-accent" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            className="h-24 animate-pulse rounded-xl border bg-accent/50"
          />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-xl border bg-accent/50" />
    </section>
  );
}
