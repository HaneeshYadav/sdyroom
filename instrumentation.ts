/**
 * Next.js instrumentation hook (auto-loaded from the project root).
 *
 * `onRequestError` is the safety net for the failures `withLogging` cannot
 * see: errors thrown while rendering a page or streaming a response, after
 * the route handler has already returned. The digest Next attaches is the
 * same value shown to the visitor by `app/error.tsx`, so a bug report
 * quoting the digest can be grepped straight to this log line.
 */
import { errorFields, logError } from "@/lib/server/log";

export async function onRequestError(
  error: unknown,
  request: {
    path?: string;
    method?: string;
    digest?: string;
  },
): Promise<void> {
  logError("unhandled_request_error", {
    route: request.path ?? null,
    method: request.method ?? null,
    digest: request.digest ?? null,
    ...errorFields(error),
  });
}
