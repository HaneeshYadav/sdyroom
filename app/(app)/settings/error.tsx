"use client";

import { Button } from "@/components/ui/button";
import { useEffect } from "react";

/**
 * Boundary for `/settings`. The page reads the profile during rendering, so
 * a database outage lands here rather than as an unhandled rejection; the
 * retry re-runs the server component. Nothing was written — the forms only
 * mutate on submit, which never ran.
 */
export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[settings] page failed:", error);
  }, [error]);

  return (
    <section className="flex flex-col gap-4" role="alert">
      <h1 className="text-2xl font-semibold">Settings could not be loaded</h1>
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
