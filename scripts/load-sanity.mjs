#!/usr/bin/env node
/**
 * Load sanity (spec PR 18): proves the hardened app holds up under a small
 * burst of concurrent requests — not a benchmark, a smoke-under-fire check.
 *
 * Usage:  LOAD_BASE_URL=http://127.0.0.1:3000 LOAD_TOTAL=400 LOAD_CONCURRENCY=25 \
 *           node scripts/load-sanity.mjs
 *
 * Reports success rate and latency percentiles; exits non-zero if any 5xx
 * answers or the success rate drops below 99%.
 */
const baseUrl = (process.env.LOAD_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const total = Number(process.env.LOAD_TOTAL ?? 400);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 25);

const targets = [
  { path: "/api/health", expect: 200 },
  { path: "/api/health/ready", expect: 200 },
  { path: "/api/metrics", expect: 200 },
  { path: "/api/rooms", expect: 401 },
];

const latencies = [];
let ok = 0;
let failed = 0;
const failures = new Map();

async function one(i) {
  const target = targets[i % targets.length];
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${target.path}`, {
      headers: { "x-request-id": `load-${i}-${Date.now()}` },
    });
    latencies.push(performance.now() - started);
    if (response.status === target.expect) {
      ok += 1;
    } else {
      failed += 1;
      const key = `${target.path} -> ${response.status}`;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
  } catch (error) {
    failed += 1;
    const key = `${target.path} -> ${error instanceof Error ? error.message : "network error"}`;
    failures.set(key, (failures.get(key) ?? 0) + 1);
  }
}

console.log(`load-sanity — ${total} requests, concurrency ${concurrency}, against ${baseUrl}`);

const queue = Array.from({ length: total }, (_, i) => i);
const workers = Array.from({ length: concurrency }, async () => {
  while (queue.length > 0) {
    await one(queue.shift());
  }
});
await Promise.all(workers);

latencies.sort((a, b) => a - b);
const pct = (p) =>
  latencies.length === 0
    ? 0
    : Math.round(latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]);

console.log(`load-sanity — ok=${ok} failed=${failed}`);
console.log(
  `load-sanity — latency ms p50=${pct(50)} p95=${pct(95)} p99=${pct(99)} max=${Math.round(latencies[latencies.length - 1] ?? 0)}`,
);
for (const [key, count] of [...failures.entries()].sort()) {
  console.log(`load-sanity — failure: ${key} × ${count}`);
}

if (failed > 0 || ok / total < 0.99) {
  console.error("load-sanity — FAILED");
  process.exit(1);
}
console.log("load-sanity — passed");
