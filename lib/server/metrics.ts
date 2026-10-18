/**
 * In-memory, single-instance request metrics fed by `withLogging`.
 *
 * Honest scope: counters live in this process only. On one instance that is
 * exact; behind a load balancer with N instances it is a 1/N sample, and
 * restarts reset the window. The endpoint says so (`"instance": "single"`)
 * rather than pretending to be a monitoring backend. Route keys are
 * normalized (`/api/rooms/<uuid>` → `/api/rooms/:id`) so private room ids
 * never appear in the payload, and identifiers are never used as keys —
 * Security §3.
 */

const WINDOW_SECONDS = 300;
const MAX_ROUTE_KEYS = 200;

type Sample = { at: number; durationMs: number; status: number };

const samples = new Map<string, Sample[]>();

/** Collapses a pathname to a low-cardinality route key. */
export function normalizeRoute(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
        return ":id";
      }
      if (/^\d+$/.test(segment)) {
        return ":id";
      }
      return segment;
    })
    .join("/");
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

/** Records one completed request. Called from the access-log path only. */
export function recordRequest(
  route: string,
  status: number,
  durationMs: number,
): void {
  const key = normalizeRoute(route);
  let bucket = samples.get(key);
  if (bucket === undefined) {
    if (samples.size >= MAX_ROUTE_KEYS) {
      return;
    }
    bucket = [];
    samples.set(key, bucket);
  }
  bucket.push({ at: Date.now(), durationMs, status });
  // Bounded per key: a busy route keeps the most recent slice; the window
  // filter below does the rest. 5000 ≈ a few minutes at launch-level traffic.
  if (bucket.length > 5000) {
    bucket.splice(0, bucket.length - 5000);
  }
}

export type MetricsPayload = {
  requests: Record<
    string,
    {
      count: number;
      p50_ms: number;
      p95_ms: number;
      errors: Record<string, number>;
    }
  >;
  window_s: number;
  instance: "single";
};

/** Snapshots the rolling window, dropping samples older than `window_s`. */
export function metricsSnapshot(windowSeconds: number = WINDOW_SECONDS): MetricsPayload {
  const cutoff = Date.now() - windowSeconds * 1000;
  const requests: MetricsPayload["requests"] = {};

  for (const [key, bucket] of samples) {
    const fresh = bucket.filter((sample) => sample.at >= cutoff);
    if (fresh.length === 0) {
      continue;
    }
    const durations = fresh.map((sample) => sample.durationMs).sort((a, b) => a - b);
    const errors: Record<string, number> = {};
    for (const sample of fresh) {
      if (sample.status >= 400) {
        const bucketKey = String(sample.status);
        errors[bucketKey] = (errors[bucketKey] ?? 0) + 1;
      }
    }
    requests[key] = {
      count: fresh.length,
      p50_ms: percentile(durations, 0.5),
      p95_ms: percentile(durations, 0.95),
      errors,
    };
  }

  return { requests, window_s: windowSeconds, instance: "single" };
}

/** Drops every sample. Tests use this; production never needs it. */
export function resetMetrics(): void {
  samples.clear();
}
