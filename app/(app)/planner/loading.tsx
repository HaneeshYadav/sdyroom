/**
 * Loading boundary for `/planner`: the page reads the current plan and the
 * viewer's rooms during rendering, so the first paint can wait here.
 */
export default function PlannerLoading() {
  return (
    <section className="flex flex-col gap-4" aria-busy="true">
      <div className="h-8 w-48 animate-pulse rounded bg-accent" />
      <div className="h-4 w-96 max-w-full animate-pulse rounded bg-accent" />
      <div className="h-64 animate-pulse rounded-xl border bg-accent/50" />
    </section>
  );
}
