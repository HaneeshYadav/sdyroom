#!/usr/bin/env node
/**
 * Smoke check against a running server (spec PR 18).
 *
 * Usage:  npm run build && npm run start   (in one shell)
 *         npm run smoke                    (in another; SMOKE_BASE_URL to aim)
 *
 * Probes the production-hardening surface only: health, readiness, metrics,
 * and the error envelope's request-id contract. Exits non-zero on the first
 * category of failure so a deploy gate can act on it.
 */
const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");

let failures = 0;

function report(name, ok, detail) {
  const status = ok ? "ok  " : "FAIL";
  console.log(`smoke ${status} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function get(path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers, redirect: "manual" });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON responses are fine for some probes.
  }
  return { response, body };
}

// 1. Liveness.
{
  const { response, body } = await get("/api/health");
  report(
    "/api/health",
    response.status === 200 && body?.status === "ok" && typeof body?.version === "string",
    `status=${response.status} version=${body?.version}`,
  );
}

// 2. Readiness — 200 expected only when the local Supabase is up.
{
  const { response, body } = await get("/api/health/ready");
  report(
    "/api/health/ready",
    response.status === 200 && body?.status === "ok",
    `status=${response.status} checks=${JSON.stringify(body?.checks)}`,
  );
}

// 3. Metrics — aggregate-only document with the documented fields.
{
  const { response, body } = await get("/api/metrics");
  report(
    "/api/metrics",
    response.status === 200 && body?.window_s === 300 && body?.instance === "single",
    `status=${response.status}`,
  );
}

// 4. Unauthenticated envelope: 401 + request_id echoing the header.
{
  const suppliedId = "smoke-req-id-0001";
  const { response, body } = await get("/api/rooms", { "x-request-id": suppliedId });
  const envelopeId = body?.error?.request_id;
  const headerId = response.headers.get("x-request-id");
  report(
    "/api/rooms unauthenticated envelope",
    response.status === 401 &&
      body?.error?.code === "unauthenticated" &&
      envelopeId === suppliedId &&
      headerId === suppliedId,
    `status=${response.status} envelope_id=${envelopeId} header_id=${headerId}`,
  );
}

// 5. A malformed caller-supplied id is replaced, not trusted.
{
  const { response, body } = await get("/api/rooms", { "x-request-id": "bad id!" });
  const envelopeId = body?.error?.request_id;
  report(
    "/api/rooms rejects malformed request id",
    response.status === 401 && typeof envelopeId === "string" && envelopeId !== "bad id!",
    `envelope_id=${envelopeId}`,
  );
}

if (failures > 0) {
  console.error(`smoke — ${failures} check(s) failed against ${baseUrl}`);
  process.exit(1);
}
console.log(`smoke — all checks passed against ${baseUrl}`);
