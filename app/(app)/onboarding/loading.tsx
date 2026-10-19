/**
 * Skeleton for `/onboarding`: the page is a single centered card, so the
 * placeholder mirrors that footprint instead of a full-width stack.
 */
export default function OnboardingLoading() {
  return (
    <div
      className="flex flex-col items-center gap-6 pt-4"
      aria-busy="true"
      aria-label="Loading setup"
    >
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 animate-pulse">
          <div className="h-6 w-40 rounded bg-muted" />
          <div className="h-4 w-full rounded bg-muted" />
          <div className="h-11 w-full rounded-md bg-muted" />
          <div className="h-9 w-32 rounded-md bg-muted" />
        </div>
      </div>
    </div>
  );
}
