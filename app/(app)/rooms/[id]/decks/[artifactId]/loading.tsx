/**
 * Deck page shell while the artifact and due state load. Session-gated.
 */
export default function DeckPageLoading() {
  return (
    <section className="flex flex-col gap-6" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <div className="h-4 w-24 animate-pulse rounded bg-accent" />
        <div className="h-8 w-48 animate-pulse rounded bg-accent" />
      </div>
      <div className="h-56 animate-pulse rounded-lg border bg-accent" />
    </section>
  );
}
