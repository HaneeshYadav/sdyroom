"use client";

import { Button } from "@/components/ui/button";
import { useEffect } from "react";

/**
 * Boundary for `/analytics`. The panel is a read-only aggregate — a failed
 * RPC lands here rather than as an unhandled rejection, and retry simply
 * re-runs the page; nothing about the data changes on a failed read.
 */
export default function AnalyticsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[analytics] page failed:", error);
  }, [error]);

  return (
    <section className="flex flex-col gap-4" role="alert">
      <h1 className="text-2xl font-semibold">Analytics could not be loaded</h1>
      <p className="text-sm text-muted-foreground">
        Something went wrong on our side — nothing was changed. Try again in a
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
