import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, readJsonBody, validationResponse } from "@/lib/api/responses";
import { createPlan, listPlans, PlanError } from "@/lib/planner/plans";
import { planSpec } from "@/lib/rate-limit/keys";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { createClient } from "@/lib/supabase/server";
import {
  createPlanSchema,
  planStatusSchema,
} from "@/lib/validation/planner";

/**
 * POST /api/plans — start (or resume) the caller's study plan.
 *
 * Personal route: the room, if any, rides the body — plans may be topic-only
 * (no room, no documents) or grounded in a room's files. Flow: session →
 * strict Zod body (no identity fields) → per-scope rate limit → service
 * probes (room access, document accessibility, daily chat quota) →
 * `create_plan`, the table's only insert path, which re-validates the whole
 * domain in the database. The returned `href` is `/planner?plan=<id>`; the
 * client drives `POST …/step` to build it.
 *
 * GET /api/plans — the caller's own plans, newest first, optional
 * `?status=active|generating|failed|archived` filter (RLS own rows only).
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 (GET) | `{ "plans": [...] }` |
 * | 201 | `{ "plan": { id, status, exam_date, deduped, href } }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "room_not_member" \| "ai_quota_exceeded" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "plan_already_active" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 500 | `{ "error": { "code": "plans_failed" } }` |
 */

function mapPlanError(error: PlanError): NextResponse {
  return errorResponse(error.code, error.message, error.status, error.issues);
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to view your plans.", 401);
  }

  const statusRaw = request.nextUrl.searchParams.get("status");
  let status: ReturnType<typeof planStatusSchema.safeParse>["data"];
  if (statusRaw !== null) {
    const parsed = planStatusSchema.safeParse(statusRaw);
    if (!parsed.success) {
      return errorResponse("validation", "That status filter is not valid.", 400, [
        { path: "status", message: "Status must be active, generating, failed or archived." },
      ]);
    }
    status = parsed.data;
  }

  try {
    const plans = await listPlans(supabase, claims.sub, status);
    return NextResponse.json({ plans });
  } catch (error) {
    if (error instanceof PlanError) {
      return mapPlanError(error);
    }
    console.error(
      "[api/plans] list failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse("plans_failed", "Could not list your plans.", 500);
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to create a study plan.", 401);
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }
  const parsed = createPlanSchema.safeParse(body.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  // Rate limit before any probe: the key needs the (validated) scope.
  const limited = await rateLimitedResponse(
    supabase,
    planSpec(parsed.data.room_id ?? null, claims.sub),
  );
  if (limited) {
    return limited;
  }

  try {
    const plan = await createPlan(supabase, claims.sub, parsed.data);
    return NextResponse.json({ plan }, { status: 201 });
  } catch (error) {
    if (error instanceof PlanError) {
      return mapPlanError(error);
    }
    console.error(
      "[api/plans] create failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse("plans_failed", "Could not start the plan.", 500);
  }
}
