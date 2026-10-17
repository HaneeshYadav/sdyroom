/**
 * Generate page shell while documents and artifacts stream in. The page is
 * session-gated (`instant = false`), so this is what a signed-in member sees
 * on navigation rather than a static placeholder.
 */
export default function GeneratePageLoading() {
  return (
    <section className="flex flex-col gap-6" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <div className="h-4 w-24 animate-pulse rounded bg-accent" />
        <div className="h-8 w-64 animate-pulse rounded bg-accent" />
        <div className="h-5 w-96 max-w-full animate-pulse rounded bg-accent" />
      </div>
      <div className="h-56 animate-pulse rounded-lg border bg-accent" />
      <div className="h-32 animate-pulse rounded-lg border bg-accent" />
    </section>
  );
}
