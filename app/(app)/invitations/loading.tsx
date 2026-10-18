/**
 * Skeleton for `/invitations`: same rhythm as the page (heading block, then
 * invitation rows) so the list does not pop in and shift the layout.
 */
export default function InvitationsLoading() {
  return (
    <div
      className="flex flex-col gap-8 animate-pulse"
      aria-busy="true"
      aria-label="Loading invitations"
    >
      <div className="flex flex-col gap-2">
        <div className="h-8 w-44 rounded-md bg-muted" />
        <div className="h-4 w-72 max-w-full rounded bg-muted" />
      </div>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-4">
            <div className="h-5 w-56 rounded bg-muted" />
            <div className="h-4 w-2/3 rounded bg-muted" />
            <div className="flex gap-3">
              <div className="h-9 w-28 rounded-md bg-muted" />
              <div className="h-9 w-24 rounded-md bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
