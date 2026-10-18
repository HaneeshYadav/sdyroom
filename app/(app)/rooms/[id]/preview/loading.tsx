export default function RoomPreviewLoading() {
  return (
    <section
      className="mx-auto flex w-full max-w-2xl flex-col gap-6"
      aria-hidden="true"
    >
      <div className="h-4 w-28 animate-pulse rounded bg-accent" />
      <div className="flex flex-col gap-2">
        <div className="h-5 w-24 animate-pulse rounded bg-accent" />
        <div className="h-8 w-3/4 animate-pulse rounded bg-accent" />
      </div>
      <div className="h-28 w-full animate-pulse rounded-lg bg-accent" />
      <div className="h-9 w-32 animate-pulse rounded-md bg-accent" />
    </section>
  );
}
