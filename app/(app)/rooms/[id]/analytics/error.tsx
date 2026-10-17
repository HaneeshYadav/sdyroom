"use client";

import { Button } from "@/components/ui/button";
import { useEffect } from "react";

/**
 * Boundary for `/rooms/[id]/analytics`. The panel is a read-only aggregate —
 * a failed RPC (or a database outage) lands here rather than as an
 * unhandled rejection; retry re-runs the page and the RPC re-proves the
 * caller's moderator rights again.
 */
export default function RoomAnalyticsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[room analytics] page failed:", error);
  }, [error]);

  return (
    <section className="flex flex-col gap-4" role="alert">
      <h1 className="text-2xl font-semibold">Room analytics could not be loaded</h1>
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
