import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api/responses";
import { analyticsDaysToCsv } from "@/lib/analytics/csv";
import {
  AnalyticsError,
  fetchPersonalAnalytics,
} from "@/lib/analytics/queries";
import { RANGE_DAYS } from "@/lib/analytics/range";
import { createClient } from "@/lib/supabase/server";
import {
  ANALYTICS_RANGE_MESSAGE,
  analyticsRangeSchema,
} from "@/lib/validation/analytics";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

/**
 * GET /api/analytics/me — the caller's own day series + summary.
 *
 * `?range=7d|30d|90d` is required: there is no default at the API layer
 * (spec: bad/missing range → 400 `validation`) — pages always send one.
 * `?format=csv` swaps the body for a CSV attachment of the same `days`
 * (row-for-row the six export columns; `/api/analytics/me.csv` is the same
 * handler behind the spec's download link).
 *
 * Identity is never a query parameter: `?user_id=…` (or anything else) is
 * ignored — the session's claims pick the subject and `analytics_me`
 * aggregates `auth.uid()` inside the database, so the endpoint cannot be
 * pointed at another user even by mistake.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ range, days, summary, plan }` or `text/csv` |
 * | 400 | `{ "error": { "code": "validation" } }` — missing/unknown range |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 500 | `{ "error": { "code": "analytics_failed" } }` |
 */
async function GET_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse(
      "unauthenticated",
      "Sign in to view your study analytics.",
      401,
    );
  }

  const parsedRange = analyticsRangeSchema.safeParse(
    request.nextUrl.searchParams.get("range"),
  );
  if (!parsedRange.success) {
    return errorResponse(
      "validation",
      "Choose a range of 7d, 30d or 90d.",
      400,
      [{ path: "range", message: ANALYTICS_RANGE_MESSAGE }],
    );
  }

  try {
    const analytics = await fetchPersonalAnalytics(supabase, {
      userId: claims.sub,
      days: RANGE_DAYS[parsedRange.data],
    });

    if (request.nextUrl.searchParams.get("format") === "csv") {
      return new NextResponse(analyticsDaysToCsv(analytics.days), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="study-analytics-${parsedRange.data}.csv"`,
        },
      });
    }

    return NextResponse.json({
      range: parsedRange.data,
      days: analytics.days,
      summary: analytics.summary,
      plan: analytics.plan,
    });
  } catch (error) {
    if (error instanceof AnalyticsError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/analytics/me] failed:", errorFields(error));
    return errorResponse(
      "analytics_failed",
      "Could not load your study analytics.",
      500,
    );
  }
}

export const GET = withLogging(GET_raw);
