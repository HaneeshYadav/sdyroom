import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api/responses";
import { archivePlan, PlanError } from "@/lib/planner/plans";
import { createClient } from "@/lib/supabase/server";
import { planIdSchema } from "@/lib/validation/planner";

type ArchiveContext = { params: Promise<{ planId: string }> };

/**
 * POST /api/plans/[planId]/archive — archive the owner's plan.
 *
 * No body. Also the cancel path for a pending generation (a `generating`
 * row holds no items, so nothing is lost), and idempotent on an
 * already-archived row (`deduped: true`). Ownership is resolved in the
 * RPC: a foreign plan is 404. An archived plan is read-only afterwards —
 * done/shift/complete-day answer 409 `plan_not_active`.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ id, archived: true, deduped }` |
 * | 400 | `{ "error": { "code": "validation" } }` (bad id) |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "plans_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: ArchiveContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to archive your plan.", 401);
  }

  const { planId } = await params;
  const parsed = planIdSchema.safeParse(planId);
  if (!parsed.success) {
    return errorResponse("validation", "That plan id is not valid.", 400, [
      { path: "planId", message: "Plan id must be a UUID." },
    ]);
  }

  try {
    const result = await archivePlan(supabase, claims.sub, parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PlanError) {
      return errorResponse(error.code, error.message, error.status, error.issues);
    }
    console.error(
      "[api/plans/archive] archive failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse("plans_failed", "Could not archive that plan.", 500);
  }
}
