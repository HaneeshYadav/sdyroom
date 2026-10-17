"use client";

import { Button } from "@/components/ui/button";

/**
 * Deck page failure boundary. The underlying error stays in the server logs.
 */
export default function DeckPageError({ reset }: { reset: () => void }) {
  return (
    <section className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-10 text-center">
      <h1 className="text-xl font-semibold">This deck could not load</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Something went wrong while opening the deck. Your session is fine —
        try again in a moment.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
