import { NextRequest } from "next/server";

import { GET as meGet } from "../me/route";

/**
 * GET /api/analytics/me.csv — the spec's download-link path: the caller's
 * own daily series as a CSV attachment. This is the `/me` handler with
 * `format=csv` forced, so the two routes can never drift in auth, range
 * validation or aggregation; `?range=` follows the same rules (required).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  url.searchParams.set("format", "csv");
  return meGet(new NextRequest(url, { headers: request.headers }));
}
