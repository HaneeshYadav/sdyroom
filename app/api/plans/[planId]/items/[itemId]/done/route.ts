import { NextResponse, type NextRequest } from "next/server";

import {
  errorResponse,
  readOptionalJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { markItemDone, PlanError } from "@/lib/planner/plans";
import { createClient } from "@/lib/supabase/server";
import {
  markItemDoneSchema,
  planIdSchema,
  planItemIdSchema,
} from "@/lib/validation/planner";

type ItemContext = { params: Promise<{ planId: string; itemId: string }> };

/**
 * POST /api/plans/[planId]/items/[itemId]/done — checkbox toggle.
 *
 * Body `{ done?: boolean }` (default `true`). Identity and ownership live
 * in `mark_plan_item`: a foreign item id is 404 (indistinguishable from
 * missing), an archived/failed/generating plan is 409 `plan_not_active`,
 * and repeating the desired state is a no-op — the first completion
 * timestamp is never rewritten. Returns the item plus the plan's fresh
 * progress so the client can reconcile its optimistic UI in one round trip.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ item: { id, done_at }, plan: { id, status, progress } }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "plan_not_active" } }` |
 * | 500 | `{ "error": { "code": "plans_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: ItemContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to update your plan.", 401);
  }

  const { planId, itemId } = await params;
  // The plan path segment is structural: `mark_plan_item` resolves the plan
  // through the item and enforces ownership there (a foreign item is 404).
  if (!planIdSchema.safeParse(planId).success) {
    return errorResponse("validation", "That plan id is not valid.", 400, [
      { path: "planId", message: "Plan id must be a UUID." },
    ]);
  }
  const parsedItem = planItemIdSchema.safeParse(itemId);
  if (!parsedItem.success) {
    return errorResponse("validation", "That item id is not valid.", 400, [
      { path: "itemId", message: "Item id must be a UUID." },
    ]);
  }

  const body = await readOptionalJsonBody(request);
  if (!body.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }
  const parsedBody = markItemDoneSchema.safeParse(body.body);
  if (!parsedBody.success) {
    return validationResponse(parsedBody.error);
  }

  try {
    const result = await markItemDone(
      supabase,
      parsedItem.data,
      parsedBody.data.done,
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PlanError) {
      return errorResponse(error.code, error.message, error.status, error.issues);
    }
    console.error(
      "[api/plans/item/done] toggle failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse("plans_failed", "Could not update that item.", 500);
  }
}
