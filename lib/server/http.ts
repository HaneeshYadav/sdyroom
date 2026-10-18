/**
 * Outbound HTTP resilience — the single place timeouts, bounded retries and
 * the failure guard live (spec: PR 18 "Outbound resilience").
 *
 * Policy, in one paragraph: every outbound call is bounded by a timeout; a
 * retry happens only for a request that is safe to repeat (GET/HEAD/PUT/DELETE
 * by method, or an explicitly flagged idempotent POST such as embeddings) and
 * only for failures that may be transient (network error, timeout, or a
 * 429/500/502/503/504 status); the failure guard trips an entire dependency
 * open after a threshold of consecutive failures and half-opens it after a
 * cooldown so a struggling upstream is not hammered while it recovers.
 * Nothing here invents behaviour for callers: each caller maps `UpstreamError`
 * onto its own error type (`AiProviderError`, `ResourceError`) so the API
 * contract and every existing error code stay exactly as they were.
 */

/** A bounded outbound failure: timeout, transport error, or non-2xx status. */
export class UpstreamError extends Error {
  readonly status: number | null;
  /** What went wrong, for callers that map onto their own error taxonomy. */
  readonly kind: "timeout" | "transport" | "status" | "body";

  constructor(
    message: string,
    kind: UpstreamError["kind"],
    status: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UpstreamError";
    this.kind = kind;
    this.status = status;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounds a promise. On expiry the underlying operation is *not* cancelled*
 * (supabase-js and fetch-without-signal cannot be) — the caller stops
 * waiting, which is what protects a request's latency budget; the stray
 * work finishes or dies with its own connection.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new UpstreamError(
              `${label} timed out after ${timeoutMs}ms`,
              "timeout",
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Statuses worth retrying: "maybe transient" answers from an upstream. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export type FetchJsonOptions = {
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Total attempts. Values above 1 retry only idempotent requests. */
  attempts?: number;
  /**
   * Force retry eligibility for a request whose method would not imply it
   * (embeddings POSTs are idempotent in effect: same input, same vectors).
   */
  idempotent?: boolean;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

const RETRY_BASE_MS = 250;

/**
 * `fetch` + parse JSON with the outbound policy applied. Throws
 * `UpstreamError` for timeouts, transport failures, non-2xx statuses and
 * unreadable bodies; resolves with the parsed body otherwise.
 */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit,
  options: FetchJsonOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 1);
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent =
    options.idempotent ?? ["GET", "HEAD", "PUT", "DELETE"].includes(method);
  const sleep = options.sleep ?? defaultSleep;
  const retryable = attempts > 1 && idempotent;

  let lastError: UpstreamError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      lastError = new UpstreamError(
        `${method} ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
        "transport",
        null,
        { cause: error },
      );
      if (retryable && attempt < attempts) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      throw lastError;
    }

    if (!response.ok) {
      lastError = new UpstreamError(
        `${method} ${url} responded with status ${response.status}`,
        "status",
        response.status,
      );
      const worthRetrying = RETRYABLE_STATUSES.has(response.status);
      if (retryable && attempt < attempts && worthRetrying) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      throw lastError;
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new UpstreamError(
        `${method} ${url} returned an unreadable body`,
        "body",
        response.status,
        { cause: error },
      );
    }
  }
  /* istanbul ignore next — the loop always returns or throws. */
  throw lastError ?? new UpstreamError(`${method} ${url} failed`, "transport");
}

export type FailureGuardOptions = {
  /** Consecutive failures that trip the circuit open. Default 5. */
  threshold?: number;
  /** How long it stays open before letting a probe through. Default 30s. */
  cooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type FailureGuard = {
  /** False while the circuit is open (or another probe is in flight). */
  allow(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
  readonly state: "closed" | "open" | "half_open";
};

/**
 * A per-dependency circuit breaker. `allow()` is the gate before a call;
 * the outcome is reported with `recordSuccess`/`recordFailure`. One probe
 * is admitted per cooldown window (half-open), so a dead dependency costs
 * one timed-out call per cooldown, not a stampede.
 */
export function createFailureGuard(
  options: FailureGuardOptions = {},
): FailureGuard {
  const threshold = options.threshold ?? 5;
  const cooldownMs = options.cooldownMs ?? 30_000;
  const now = options.now ?? Date.now;

  let failures = 0;
  let openedAt: number | null = null;
  let probing = false;

  return {
    allow(): boolean {
      if (openedAt === null) return true;
      if (now() - openedAt < cooldownMs) return false;
      // Cooldown elapsed: half-open. Admit exactly one probe.
      if (probing) return false;
      probing = true;
      return true;
    },
    recordSuccess(): void {
      failures = 0;
      openedAt = null;
      probing = false;
    },
    recordFailure(): void {
      failures += 1;
      if (openedAt !== null || failures >= threshold) {
        openedAt = now();
        probing = false;
      }
    },
    get state(): "closed" | "open" | "half_open" {
      if (openedAt === null) return "closed";
      if (now() - openedAt < cooldownMs) return "open";
      return "half_open";
    },
  };
}
