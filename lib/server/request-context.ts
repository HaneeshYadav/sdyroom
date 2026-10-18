import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context that any code running inside a request can read
 * synchronously — most importantly `errorResponse`, which must attach the
 * request id to the error envelope without becoming async and without a
 * `headers()` call (that API throws outside a Next.js request scope, which
 * would break every direct-invocation test).
 *
 * The context is entered by `withLogging`, the single wrapper around every
 * API route export. Nothing else enters it, so the store can never leak
 * across requests: AsyncLocalStorage isolates each `run` invocation.
 */
export type RequestContext = {
  requestId: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` visible to every await it reaches. */
export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

/** The current request's context, or `undefined` outside a wrapped route. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The current request id, or `null` when no request context is active
 * (unit tests calling helpers directly, background work outside a request).
 */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}
