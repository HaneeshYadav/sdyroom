"use client";

import { Button } from "@/components/ui/button";

/**
 * Ask page failure boundary. The underlying error stays in the server logs;
 * the visitor only sees a stable message and a retry.
 */
export default function AskPageError({ reset }: { reset: () => void }) {
  return (
    <section className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-10 text-center">
      <h1 className="text-xl font-semibold">Ask my notes could not load</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Something went wrong while opening the question page. Your session is
        fine — try again in a moment.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
