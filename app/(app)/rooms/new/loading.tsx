/**
 * Skeleton for `/rooms/new`: heading and the single create-room card, so the
 * form does not pop in against an empty page.
 */
export default function RoomNewLoading() {
  return (
    <div
      className="flex flex-col gap-8 animate-pulse"
      aria-busy="true"
      aria-label="Loading room form"
    >
      <div className="flex flex-col gap-2">
        <div className="h-8 w-56 rounded-md bg-muted" />
      </div>
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="h-5 w-36 rounded bg-muted" />
            <div className="h-11 w-full rounded-md bg-muted" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <div className="h-5 w-24 rounded bg-muted" />
              <div className="h-11 w-full rounded-md bg-muted" />
            </div>
            <div className="flex flex-col gap-2">
              <div className="h-5 w-24 rounded bg-muted" />
              <div className="h-11 w-full rounded-md bg-muted" />
            </div>
          </div>
          <div className="flex gap-3">
            <div className="h-9 w-32 rounded-md bg-muted" />
            <div className="h-9 w-24 rounded-md bg-muted" />
          </div>
        </div>
      </div>
    </div>
  );
}
