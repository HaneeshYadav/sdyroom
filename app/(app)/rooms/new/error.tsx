"use client";

import { Button } from "@/components/ui/button";
import { useEffect } from "react";

/**
 * Boundary for `/rooms/new`. Overrides the discovery-flavoured `rooms/error.tsx`
 * above it, which talks about loading public rooms — this route is the create
 * form. Nothing was created: the write only happens on submit, which never ran.
 */
export default function RoomNewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[rooms/new] page failed:", error);
  }, [error]);

  return (
    <section className="flex flex-col gap-4" role="alert">
      <h1 className="text-2xl font-semibold">
        Room creation could not be loaded
      </h1>
      <p className="text-sm text-muted-foreground">
        Something went wrong on our side. Nothing was created — try again in a
        moment.
      </p>
      <div>
        <Button type="button" size="sm" onClick={reset}>
          Try again
        </Button>
      </div>
    </section>
  );
}
