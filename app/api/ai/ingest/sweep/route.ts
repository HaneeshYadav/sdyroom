import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, readOptionalJsonBody, validationResponse } from "@/lib/api/responses";
import { IngestError, INGEST_MESSAGES, sweepIngests } from "@/lib/ai/ingest";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { sweepSpec } from "@/lib/rate-limit/keys";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { ingestSweepSchema } from "@/lib/validation/ai";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

/**
 * POST /api/ai/ingest/sweep — picks up stuck ingest rows and advances each
 * by one `auto` step. Body: `{}`, `{"room_id"}` or `{"room_id","limit"}`.
 *
 * Eligibility (non-terminal, no stored error, untouched for five minutes) is
 * enforced by the query itself, and only rows the caller can already read
 * appear (RLS). `room_id` is an explicit narrowing, membership-proven before
 * any work — a non-member gets the same 404 as a missing room.
 *
 * Answer: `200 { picked, statuses: [{ resource_id, status }] }`. Rows that
 * error mid-flight still appear with their current status: one bad document
 * never abandons the rest of the sweep.
 */
async function POST_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse(
      "unauthenticated",
      "Sign in to sweep indexing jobs.",
      401,
    );
  }

  const limited = await rateLimitedResponse(
    supabase,
    sweepSpec(claims.sub),
    "Too many sweep requests — wait a minute and try again.",
  );

  if (limited) {
    return limited;
  }

  const parsedBody = await readOptionalJsonBody(request);

  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsed = ingestSweepSchema.safeParse(parsedBody.body);

  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  try {
    if (parsed.data.room_id !== undefined) {
      await requireRoomMembership(supabase, parsed.data.room_id);
    }

    const result = await sweepIngests(supabase, {
      userId: claims.sub,
      roomId: parsed.data.room_id ?? null,
      limit: parsed.data.limit,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }

    if (error instanceof IngestError) {
      return errorResponse(error.code, error.message, error.status);
    }

    logError("[api/ai/ingest/sweep] failed:", errorFields(error));

    return errorResponse(
      "ingest_failed",
      INGEST_MESSAGES.ingest_failed,
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
