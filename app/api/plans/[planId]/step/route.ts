import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api/responses";
import { getPlanRow, PlanError, runPlanStep } from "@/lib/planner/plans";
import { AiProviderError } from "@/lib/ai/provider";
import { RetrieveError } from "@/lib/ai/retrieve";
import { planSpec } from "@/lib/rate-limit/keys";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { createClient } from "@/lib/supabase/server";
import { planIdSchema } from "@/lib/validation/planner";

type StepContext = { params: Promise<{ planId: string }> };

/**
 * POST /api/plans/[planId]/step — one bounded generation step: signals →
 * retrieve → prompt → complete → parse-validate → `generate_plan`.
 *
 * Idempotent once the plan is `active` or `failed` (existing state comes
 * back with `deduped: true`, no second provider call); an `archived` plan is
 * 409 `plan_not_active` (read-only). Quota failure fails the plan and
 * answers 403. Malformed model output — at the TS gate or inside the SQL
 * validator — fails the plan with `ai_provider_failed` and answers 502:
 * never an `active` row built from junk.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ status: "active" \| "failed", item_count?, days?, summary?, model?, provider, error_code?, deduped }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "ai_quota_exceeded" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "plan_not_active" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 502 | `{ "error": { "code": "ai_provider_failed" } }` |
 * | 500 | `{ "error": { "code": "plans_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: StepContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to generate your plan.", 401);
  }

  const { planId } = await params;
  const parsed = planIdSchema.safeParse(planId);
  if (!parsed.success) {
    return errorResponse("validation", "That plan id is not valid.", 400, [
      { path: "planId", message: "Plan id must be a UUID." },
    ]);
  }

  // 404 before rate limiting (an unknown id is not a spend), then the
  // per-scope key needs the plan's room (`personal` when it has none).
  const plan = await getPlanRow(supabase, claims.sub, parsed.data);
  if (!plan) {
    return errorResponse("not_found", "That plan does not exist or is not available.", 404);
  }

  const limited = await rateLimitedResponse(
    supabase,
    planSpec(plan.room_id, claims.sub),
  );
  if (limited) {
    return limited;
  }

  try {
    const result = await runPlanStep(supabase, {
      userId: claims.sub,
      planId: plan.id,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PlanError) {
      return errorResponse(error.code, error.message, error.status, error.issues);
    }
    if (error instanceof AiProviderError || error instanceof RetrieveError) {
      return errorResponse("ai_provider_failed", error.message, 502);
    }
    console.error(
      "[api/plans/step] step failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse("plans_failed", "Could not advance the plan.", 500);
  }
}
