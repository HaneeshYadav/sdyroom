import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api/responses";
import { getPlan, itemsToCsv, PlanError } from "@/lib/planner/plans";
import { createClient } from "@/lib/supabase/server";
import { planIdSchema } from "@/lib/validation/planner";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type PlanContext = { params: Promise<{ planId: string }> };

/**
 * GET /api/plans/[planId] — full plan detail for the owner: the plan row,
 * its items in schedule order (keyed `date`, citation present only when the
 * item points at a real document), and the `plan_stats` progress authority.
 * A foreign or missing id is 404 (RLS + explicit owner match + the RPC's
 * own `not_found` — indistinguishable by design).
 *
 * CSV download: `?format=csv` or a `<uuid>.csv` id suffix returns the
 * spec's columns (`date,kind,subject,task,est_minutes,done`) as an inline
 * attachment instead of JSON.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ plan, items, progress, item_count, days }` or `text/csv` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 400 | `{ "error": { "code": "validation" } }` (bad id) |
 * | 500 | `{ "error": { "code": "plans_failed" } }` |
 */
async function GET_raw(request: NextRequest, { params }: PlanContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to view this plan.", 401);
  }

  const { planId: rawPlanId } = await params;
  const wantsCsv =
    request.nextUrl.searchParams.get("format") === "csv" || rawPlanId.endsWith(".csv");
  const planId = wantsCsv ? rawPlanId.replace(/\.csv$/, "") : rawPlanId;
  const parsed = planIdSchema.safeParse(planId);
  if (!parsed.success) {
    return errorResponse("validation", "That plan id is not valid.", 400, [
      { path: "planId", message: "Plan id must be a UUID." },
    ]);
  }

  try {
    const detail = await getPlan(supabase, claims.sub, parsed.data);

    if (wantsCsv) {
      const csv = itemsToCsv(detail.items);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="study-plan-${detail.plan.id}.csv"`,
        },
      });
    }

    return NextResponse.json({
      plan: detail.plan,
      items: detail.items,
      progress: detail.progress,
      item_count: detail.item_count,
      days: detail.days,
    });
  } catch (error) {
    if (error instanceof PlanError) {
      return errorResponse(error.code, error.message, error.status, error.issues);
    }
    logError("[api/plans/planId] read failed:", errorFields(error));
    return errorResponse("plans_failed", "Could not read that plan.", 500);
  }
}

export const GET = withLogging(GET_raw);
