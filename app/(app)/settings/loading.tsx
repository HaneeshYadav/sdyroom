/**
 * Skeleton for `/settings`: same vertical rhythm as the page (heading, four
 * card blocks) so the layout does not jump when the profile lands.
 */
export default function SettingsLoading() {
  return (
    <div
      className="flex flex-col gap-8 animate-pulse"
      aria-busy="true"
      aria-label="Loading settings"
    >
      <div className="flex flex-col gap-2">
        <div className="h-8 w-40 rounded-md bg-muted" />
        <div className="h-4 w-72 max-w-full rounded bg-muted" />
      </div>
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-4">
            <div className="h-5 w-44 rounded bg-muted" />
            <div className="h-4 w-2/3 rounded bg-muted" />
            <div className="h-11 w-full rounded-md bg-muted" />
            <div className="h-9 w-32 rounded-md bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
