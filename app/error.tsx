"use client";

import { Button } from "@/components/ui/button";

/**
 * Root error boundary. Anything that escapes a section boundary (or a
 * failure in the root layout itself) lands here: the visitor gets one
 * stable message and a retry, and the underlying error — including the
 * `digest` Next attaches — is in the server logs via
 * `instrumentation.ts#onRequestError`. The digest is shown so a bug report
 * can quote one value that ties the report to those logs; it is an opaque
 * hash, not a stack trace or an identifier.
 */
export default function GlobalAppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-10 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        An unexpected error occurred. Your session is fine — try again in a
        moment.
      </p>
      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground">
          Reference: {error.digest}
        </p>
      ) : null}
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
