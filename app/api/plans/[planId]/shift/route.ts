import { NextResponse, type NextRequest } from "next/server";

import {
  errorResponse,
  readOptionalJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { getPlanRow, PlanError, shiftPlan } from "@/lib/planner/plans";
import { createClient } from "@/lib/supabase/server";
import { planIdSchema, shiftPlanSchema } from "@/lib/validation/planner";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type ShiftContext = { params: Promise<{ planId: string }> };

/**
 * POST /api/plans/[planId]/shift — "I missed today": move what remains
 * from `from_date` forward.
 *
 * Body `{ from_date: "YYYY-MM-DD", mode?: "shift_remaining" }`. The route
 * never computes dates from request input beyond validating the window
 * start: `lib/planner/shift.ts` derives the moves from `from_date`'s own lag
 * behind today (shift = max(0, today − from_date), applied to every undone
 * item on/after the window start), and `shift_plan` re-validates ownership,
 * forward-only motion, the exam cap and concurrent completions in the
 * database. Items past the exam date are clamped onto it and counted in
 * `past_exam_date` for the response — never silently dropped. A call from
 * today or the future is the "already on time" no-op.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ plan, moved, past_exam_date, skipped_done }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "plan_not_active" } }` |
 * | 500 | `{ "error": { "code": "plans_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: ShiftContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to shift your plan.", 401);
  }

  const { planId } = await params;
  const parsedPlan = planIdSchema.safeParse(planId);
  if (!parsedPlan.success) {
    return errorResponse("validation", "That plan id is not valid.", 400, [
      { path: "planId", message: "Plan id must be a UUID." },
    ]);
  }

  const plan = await getPlanRow(supabase, claims.sub, parsedPlan.data);
  if (!plan) {
    return errorResponse("not_found", "That plan does not exist or is not available.", 404);
  }

  const body = await readOptionalJsonBody(request);
  if (!body.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }
  const parsedBody = shiftPlanSchema.safeParse(body.body);
  if (!parsedBody.success) {
    return validationResponse(parsedBody.error);
  }

  try {
    const result = await shiftPlan(
      supabase,
      claims.sub,
      parsedPlan.data,
      parsedBody.data.from_date,
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PlanError) {
      return errorResponse(error.code, error.message, error.status, error.issues);
    }
    logError("[api/plans/shift] shift failed:", errorFields(error));
    return errorResponse("plans_failed", "Could not shift that plan.", 500);
  }
}

export const POST = withLogging(POST_raw);
