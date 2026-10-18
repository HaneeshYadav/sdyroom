import { type NextRequest } from "next/server";

import { errorResponse, readOptionalJsonBody, validationResponse } from "@/lib/api/responses";
import {
  AskError,
  runAsk,
  type AskStreamEvent,
} from "@/lib/ai/ask";
import { AiProviderError } from "@/lib/ai/provider";
import { RetrieveError } from "@/lib/ai/retrieve";
import { askSpec } from "@/lib/rate-limit/keys";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { askBodySchema } from "@/lib/validation/ask";
import { roomIdSchema } from "@/lib/validation/rooms";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type AskContext = { params: Promise<{ id: string }> };

/**
 * POST /api/rooms/[id]/ask — "Ask my notes": one room-scoped RAG question.
 *
 * Identity is session-only; the room id is membership-proven (404 for
 * non-members and missing rooms alike). The answer is produced by
 * `runAsk` — retrieval over the room's indexed documents, a completion over
 * those excerpts only, then a `record_qa` write that is the history table's
 * only insert path — and streamed to the client as NDJSON:
 *
 * ```
 * {"type":"citations","citations":[…]}
 * {"type":"delta","text":"…"}
 * {"type":"done","qa_id":"…","conversation_id":"…","usage":{…}}
 * ```
 *
 * Every failure is decided before the first event, so a non-2xx answer is a
 * plain JSON error envelope; a dropped stream is finished client-side from
 * the missing `done` event.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | NDJSON stream (above) |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "ai_quota_exceeded" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "no_documents_indexed" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 502 | `{ "error": { "code": "ai_provider_failed" } }` |
 * | 500 | `{ "error": { "code": "ask_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: AskContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to ask a question.", 401);
  }

  const { id: roomId } = await params;
  const parsedRoom = roomIdSchema.safeParse(roomId);
  if (!parsedRoom.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  try {
    await requireRoomMembership(supabase, parsedRoom.data);
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/rooms/ask] membership check failed:", errorFields(error));
    return errorResponse("ask_failed", "Could not check room access.", 500);
  }

  const limited = await rateLimitedResponse(
    supabase,
    askSpec(parsedRoom.data, claims.sub),
  );
  if (limited) {
    return limited;
  }

  const body = await readOptionalJsonBody(request);
  if (!body.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }
  const parsed = askBodySchema.safeParse(body.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const conversationId = parsed.data.conversation_id ?? crypto.randomUUID();

  try {
    const events = runAsk(supabase, {
      roomId: parsedRoom.data,
      userId: claims.sub,
      question: parsed.data.question,
      resourceIds: parsed.data.resource_ids,
      conversationId,
    });

    // Pull the first failure (if any) *before* opening the stream, so a
    // non-2xx answer stays a plain JSON envelope with the right status.
    const iterator = events[Symbol.asyncIterator]();
    const first = await iterator.next();

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (event: AskStreamEvent) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          if (!first.done) {
            write(first.value);
          }
          for (;;) {
            const next = await iterator.next();
            if (next.done) {
              break;
            }
            write(next.value);
          }
          controller.close();
        } catch (error) {
          // A failure after the stream opened can no longer change the HTTP
          // status — surface it as a terminal NDJSON error event so the
          // client shows the failed state instead of waiting for `done`.
          const code =
            error instanceof AskError
              ? error.code
              : error instanceof AiProviderError || error instanceof RetrieveError
                ? error.code
                : "ask_failed";
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: "error", code })}\n`,
            ),
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AskError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof AiProviderError || error instanceof RetrieveError) {
      return errorResponse("ai_provider_failed", error.message, 502);
    }
    logError("[api/rooms/ask] ask failed:", errorFields(error));
    return errorResponse("ask_failed", "Could not answer that question.", 500);
  }
}

export const POST = withLogging(POST_raw);
