import { NextResponse, type NextRequest } from "next/server";
import { metricsSnapshot } from "@/lib/server/metrics";
import { withLogging } from "@/lib/server/with-logging";

/**
 * Aggregate health of this instance: a rolling 300 s window of request
 * counts, error counts by status class, and latency percentiles, keyed by
 * normalized route (`/api/rooms/:id/join` — path parameters never appear,
 * so nothing here can identify a user or resource). Single-instance
 * scope only: each process answers for itself (spec PR 18).
 */
async function GET_raw(request: NextRequest): Promise<NextResponse> {
  void request;
  return NextResponse.json(metricsSnapshot(), {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withLogging(GET_raw);
