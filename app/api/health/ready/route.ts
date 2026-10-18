import { NextResponse, type NextRequest } from "next/server";
import { logWarn } from "@/lib/server/log";
import { withLogging } from "@/lib/server/with-logging";

/**
 * Readiness: "can this instance answer real traffic right now?" — it probes
 * the two dependencies every page depends on (PostgREST and Storage) with a
 * short timeout each. Any HTTP response counts as reachable: an auth error
 * or a 404 still proves the service is up and routing, which is all
 * readiness needs; only a transport failure or timeout marks it down.
 *
 * The probes use `fetch` (not the service clients) on purpose: readiness
 * must not depend on session cookies, RLS, or the app's own client config,
 * and a plain fetch is what a load balancer's health check would do.
 *
 * 200 `ok` when both respond, 503 `degraded` otherwise, always with
 * `cache-control: no-store`. The body builder is exported so unit tests can
 * pin the mapping without a network.
 */

const PROBE_TIMEOUT_MS = 2_000;

export type ReadinessChecks = { db: boolean; storage: boolean };

/** Pure mapping from probe outcomes to the readiness document. */
export function readinessDocument(
  checks: ReadinessChecks,
  checkedAt: string,
): { status: "ok" | "degraded"; checks: { db: string; storage: string }; checked_at: string } {
  const healthy = checks.db && checks.storage;
  return {
    status: healthy ? "ok" : "degraded",
    checks: {
      db: checks.db ? "ok" : "down",
      storage: checks.storage ? "ok" : "down",
    },
    checked_at: checkedAt,
  };
}

/** 200 only when every dependency answered. */
export function readinessStatus(checks: ReadinessChecks): 200 | 503 {
  return checks.db && checks.storage ? 200 : 503;
}

async function probe(url: string, apiKey: string): Promise<boolean> {
  try {
    await fetch(url, {
      method: "GET",
      headers: { apikey: apiKey, authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    return true;
  } catch {
    return false;
  }
}

async function GET_raw(request: NextRequest): Promise<NextResponse> {
  void request;
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  let checks: ReadinessChecks;
  if (!baseUrl || !apiKey) {
    // Missing configuration is itself a readiness failure, and the one an
    // operator most needs to see named in the log.
    logWarn("readiness_config_missing", {
      missing: [
        ...(baseUrl ? [] : ["NEXT_PUBLIC_SUPABASE_URL"]),
        ...(apiKey ? [] : ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]),
      ],
    });
    checks = { db: false, storage: false };
  } else {
    const [db, storage] = await Promise.all([
      probe(`${baseUrl.replace(/\/+$/, "")}/rest/v1/`, apiKey),
      probe(`${baseUrl.replace(/\/+$/, "")}/storage/v1/bucket`, apiKey),
    ]);
    checks = { db, storage };
    if (!db || !storage) {
      logWarn("readiness_degraded", { db, storage });
    }
  }

  const body = readinessDocument(checks, new Date().toISOString());
  return NextResponse.json(body, {
    status: readinessStatus(checks),
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withLogging(GET_raw);
