import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, readOptionalJsonBody, validationResponse } from "@/lib/api/responses";
import { AiProviderError } from "@/lib/ai/provider";
import { advanceIngest, IngestError, INGEST_MESSAGES } from "@/lib/ai/ingest";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { ingestSpec } from "@/lib/rate-limit/keys";
import { createClient } from "@/lib/supabase/server";
import { ingestStepSchema } from "@/lib/validation/ai";
import { resourceIdSchema } from "@/lib/validation/resources";

type IngestContext = { params: Promise<{ resourceId: string }> };

/**
 * POST /api/ai/ingest/[resourceId] — advances one document's ingest state by
 * exactly one step. Body `{}` (or absent) means `{"step":"auto"}`.
 *
 * The database owns every gate (`ingest_begin` re-checks ownership/membership,
 * size and type against `ai_resource_for_ingest`); this route owns transport:
 * session → uuid → rate limit → body → dispatch → documented envelope.
 *
 * Success answers `200 { status, step_done, chunks?, tokens?, model?,
 * provider?, error_code? }` — including *document outcomes* like
 * `failed/no_text_layer`, which are states, not HTTP errors. HTTP errors are
 * the published codes: 400/401/403/404/413/415/429/502/500.
 */
export async function POST(request: NextRequest, { params }: IngestContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse(
      "unauthenticated",
      INGEST_MESSAGES.unauthenticated,
      401,
    );
  }

  const { resourceId } = await params;
  const parsedId = resourceIdSchema.safeParse(resourceId);

  if (!parsedId.success) {
    return errorResponse(
      "validation",
      "That resource id is not valid.",
      400,
      [{ path: "resourceId", message: "Resource id must be a UUID." }],
    );
  }

  const limited = await rateLimitedResponse(
    supabase,
    ingestSpec(claims.sub),
    INGEST_MESSAGES.rate_limited,
  );

  if (limited) {
    return limited;
  }

  const parsedBody = await readOptionalJsonBody(request);

  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsedStep = ingestStepSchema.safeParse(parsedBody.body);

  if (!parsedStep.success) {
    return validationResponse(parsedStep.error);
  }

  try {
    const result = await advanceIngest(supabase, {
      resourceId: parsedId.data,
      step: parsedStep.data.step,
      userId: claims.sub,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof IngestError) {
      return errorResponse(error.code, error.message, error.status);
    }

    if (error instanceof AiProviderError) {
      return errorResponse(error.code, error.message, 502);
    }

    console.error(
      "[api/ai/ingest] step failed:",
      error instanceof Error ? error.message : error,
    );

    return errorResponse("ingest_failed", INGEST_MESSAGES.ingest_failed, 500);
  }
}
