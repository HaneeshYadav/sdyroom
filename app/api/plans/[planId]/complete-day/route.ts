import { NextResponse, type NextRequest } from "next/server";

import {
  errorResponse,
  readOptionalJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { completeDay, PlanError } from "@/lib/planner/plans";
import { createClient } from "@/lib/supabase/server";
import { completeDaySchema, planIdSchema } from "@/lib/validation/planner";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type CompleteDayContext = { params: Promise<{ planId: string }> };

/**
 * POST /api/plans/[planId]/complete-day — "mark all of a day done".
 *
 * Body `{ date: "YYYY-MM-DD" }`. Idempotent inside `complete_plan_day`:
 * only items not yet done are touched, so a repeat reports
 * `completed: 0` with unchanged progress. Ownership is resolved in the RPC
 * (foreign plan → 404), and a non-`active` plan is 409 `plan_not_active`
 * (an archived plan is read-only).
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ completed: number, progress }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "plan_not_active" } }` |
 * | 500 | `{ "error": { "code": "plans_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: CompleteDayContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to update your plan.", 401);
  }

  const { planId } = await params;
  const parsedPlan = planIdSchema.safeParse(planId);
  if (!parsedPlan.success) {
    return errorResponse("validation", "That plan id is not valid.", 400, [
      { path: "planId", message: "Plan id must be a UUID." },
    ]);
  }

  const body = await readOptionalJsonBody(request);
  if (!body.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }
  const parsedBody = completeDaySchema.safeParse(body.body);
  if (!parsedBody.success) {
    return validationResponse(parsedBody.error);
  }

  try {
    const result = await completeDay(supabase, parsedPlan.data, parsedBody.data.date);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PlanError) {
      return errorResponse(error.code, error.message, error.status, error.issues);
    }
    logError("[api/plans/complete-day] complete failed:", errorFields(error));
    return errorResponse("plans_failed", "Could not complete that day.", 500);
  }
}

export const POST = withLogging(POST_raw);
