"use client";

import { Button } from "@/components/ui/button";
import { useEffect } from "react";

/**
 * Boundary for `/planner`. Plan and room reads happen during rendering, so a
 * database outage lands here rather than as an unhandled rejection; nothing
 * about the plan changes on a failed read — retry simply re-runs the page.
 */
export default function PlannerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[planner] page failed:", error);
  }, [error]);

  return (
    <section className="flex flex-col gap-4" role="alert">
      <h1 className="text-2xl font-semibold">Your plan could not be loaded</h1>
      <p className="text-sm text-muted-foreground">
        Something went wrong on our side. Nothing was changed — try again in a
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
