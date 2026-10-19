"use client";

import { Button } from "@/components/ui/button";
import { useEffect } from "react";

/**
 * Boundary for `/onboarding`. The page reads the profile during rendering, so
 * an outage lands here rather than as an unhandled rejection; the retry
 * re-runs the server component. Nothing was saved — the alias is only written
 * on submit, which never ran.
 */
export default function OnboardingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[onboarding] page failed:", error);
  }, [error]);

  return (
    <section className="flex flex-col items-center gap-4 pt-4" role="alert">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold">Setup could not be loaded</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our side. Nothing was saved — try again in a
          moment.
        </p>
        <div className="mt-4">
          <Button type="button" size="sm" onClick={reset}>
            Try again
          </Button>
        </div>
      </div>
    </section>
  );
}
