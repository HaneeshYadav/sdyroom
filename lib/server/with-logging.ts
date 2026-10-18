import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { errorFields, logError, logInfo } from "./log";
import { recordRequest } from "./metrics";
import { runWithRequestContext } from "./request-context";
import { resolveRequestId } from "./request-id";

/**
 * The single access-logging wrapper around every API route export.
 *
 * It is the mechanism chosen over middleware for per-request timing, for one
 * concrete reason: Next.js middleware finishes before the route handler runs,
 * so it can never observe the handler's status or duration (`after()` is not
 * available in middleware either). Wrapping the export is the only way to log
 * an honest `status` and `duration_ms`.
 *
 * Per request it: resolves the correlation id (preserving a well-formed
 * caller-supplied `x-request-id`, minting one otherwise), enters the request
 * context so `errorResponse` can attach the id synchronously, times the
 * handler, emits one access line, feeds the metrics window, and echoes the id
 * as the `x-request-id` response header. An unexpected throw is logged with
 * its stack (server-side only) and answered with the standard error envelope,
 * so a panic never reaches a client as a stack trace — Security §5.
 *
 * The generic signature preserves the exact handler type: Next's typed
 * `{ params }: { params: Promise<…> }` handlers and zero-arg handlers like
 * `GET()` all stay assignable, and the call sites keep their inference.
 * The `any[]` constraint is what makes that work under `strictFunctionTypes`
 * (`never[]` would reject handlers whose second argument is required).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withLogging<T extends (request: NextRequest, ...args: any[]) => Promise<Response>>(
  handler: T,
): T {
  return (async (
    request: NextRequest,
    ...rest: unknown[]
  ): Promise<Response> => {
    const requestId = resolveRequestId(request.headers.get("x-request-id"));
    const userId = request.headers.get("x-user-id");
    const started = performance.now();

    return runWithRequestContext({ requestId }, async () => {
      let response: Response;
      try {
        response = await (
          handler as (request: NextRequest, ...args: unknown[]) => Promise<Response>
        )(request, ...rest);
      } catch (error) {
        logError("unhandled_route_error", {
          route: request.nextUrl.pathname,
          method: request.method,
          ...errorFields(error),
        });
        response = errorResponse(
          "internal",
          "Something went wrong. Please try again.",
          500,
        );
      }

      const durationMs = Math.round(performance.now() - started);
      logInfo("request", {
        route: request.nextUrl.pathname,
        method: request.method,
        status: response.status,
        duration_ms: durationMs,
        user_id: userId === null || userId === "" ? null : userId,
      });
      recordRequest(request.nextUrl.pathname, response.status, durationMs);

      // Echo the id on the way out so a user can quote it from devtools
      // even for successful responses.
      response.headers.set("x-request-id", requestId);
      return response;
    });
  }) as T;
}
