import { POST } from "@/app/api/rooms/[id]/ask/route";
import { GET as historyGET } from "@/app/api/rooms/[id]/ask/history/route";
import { GET as documentsGET } from "@/app/api/rooms/[id]/ask/documents/route";
import {
  AskError,
  type AskStreamEvent,
  type AskDocument,
  type AskHistoryItem,
} from "@/lib/ai/ask";
import { AiProviderError } from "@/lib/ai/provider";
import { RetrieveError } from "@/lib/ai/retrieve";
import { ASK_LIMIT } from "@/lib/rate-limit/keys";
import { RoomAccessError } from "@/lib/rooms/access";
import { encodeCursor } from "@/lib/notifications/validation";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, rateLimitedResponse, requireRoomMembership, runAsk, listAskHistory, listAskDocuments } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    rateLimitedResponse: vi.fn(),
    requireRoomMembership: vi.fn(),
    runAsk: vi.fn(),
    listAskHistory: vi.fn(),
    listAskDocuments: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rate-limit/check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/check")>()),
  rateLimitedResponse,
}));
vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomMembership,
}));
vi.mock("@/lib/ai/ask", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/ask")>();
  return { ...original, runAsk, listAskHistory, listAskDocuments };
});

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM = "11111111-1111-4111-8111-111111111111";

function askRequest(body?: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/rooms/${ROOM}/ask`, {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  });
}

function historyRequest(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/rooms/${ROOM}/ask/history${query}`,
  );
}

function documentsRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/rooms/${ROOM}/ask/documents`);
}

function context() {
  return { params: Promise.resolve({ id: ROOM }) };
}

async function readNdjson(response: Response): Promise<AskStreamEvent[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AskStreamEvent);
}

function successEvents(): AskStreamEvent[] {
  return [
    {
      type: "citations",
      citations: [
        {
          n: 1,
          resource_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          title: "Notes",
          href: `/rooms/${ROOM}`,
        },
      ],
    },
    { type: "delta", text: "Answer [1]." },
    {
      type: "done",
      qa_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      conversation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        retrieval_tokens: 2,
        retrieved_chunks: 1,
        chat_used_today: 15,
        chat_limit: 100000,
      },
    },
  ];
}

async function* fromEvents(events: AskStreamEvent[]): AsyncGenerator<AskStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

beforeEach(() => {
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  rateLimitedResponse.mockResolvedValue(null);
  requireRoomMembership.mockResolvedValue(undefined);
  runAsk.mockReset();
  listAskHistory.mockReset();
  listAskDocuments.mockReset();
  createClient.mockResolvedValue({ auth: { getClaims } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/** Mirrors a real async generator: the failure surfaces on first `next()`. */
async function* rejectWith(error: Error): AsyncGenerator<AskStreamEvent> {
  throw error;
}

describe("POST /api/rooms/[id]/ask", () => {
  it("rejects unauthenticated requests with 401 before anything else", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await POST(askRequest("{}"), context());

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(rateLimitedResponse).not.toHaveBeenCalled();
    expect(runAsk).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid room id with 400 before the membership check", async () => {
    const response = await POST(
      askRequest("{}"),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(requireRoomMembership).not.toHaveBeenCalled();
  });

  it("answers a non-member with the same 404 as a missing room", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );

    const response = await POST(askRequest("{}"), context());

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(rateLimitedResponse).not.toHaveBeenCalled();
  });

  it("answers an over-ceiling caller with 429 under the ask key", async () => {
    rateLimitedResponse.mockResolvedValue(
      NextResponse.json(
        { error: { code: "rate_limited", message: "slow down" } },
        { status: 429, headers: { "Retry-After": "60" } },
      ),
    );

    const response = await POST(askRequest("{}"), context());

    expect(response.status).toBe(429);
    expect(rateLimitedResponse).toHaveBeenCalledWith(
      expect.anything(),
      { key: `ask:${ROOM}:${USER}`, ...ASK_LIMIT },
    );
    expect(runAsk).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body with 400 invalid_json", async () => {
    const response = await POST(askRequest("{nope"), context());

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
    expect(runAsk).not.toHaveBeenCalled();
  });

  it("rejects an empty question with 400 validation", async () => {
    const response = await POST(askRequest("{}"), context());

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(runAsk).not.toHaveBeenCalled();
  });

  it("streams citations, one delta and done as NDJSON on success", async () => {
    runAsk.mockImplementation(() => fromEvents(successEvents()));

    const response = await POST(
      askRequest(JSON.stringify({ question: "What is torque?" })),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const events = await readNdjson(response);
    expect(events.map((event) => event.type)).toEqual(["citations", "delta", "done"]);

    const input = runAsk.mock.calls[0][1];
    expect(input).toMatchObject({ roomId: ROOM, userId: USER, question: "What is torque?" });
    // A conversation id is always supplied, even when the body omits it.
    expect(input.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("passes a client-supplied conversation id and resource filter through", async () => {
    runAsk.mockImplementation(() => fromEvents(successEvents()));
    const conversationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const resourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    await POST(
      askRequest(
        JSON.stringify({
          question: "q",
          conversation_id: conversationId,
          resource_ids: [resourceId],
        }),
      ),
      context(),
    );

    expect(runAsk.mock.calls[0][1]).toMatchObject({
      conversationId,
      resourceIds: [resourceId],
    });
  });

  it("maps no_documents_indexed to 409 before the stream opens", async () => {
    runAsk.mockImplementation(() =>
      rejectWith(
        new AskError(
          "no_documents_indexed",
          "Index at least one document before asking a question.",
          409,
        ),
      ),
    );

    const response = await POST(askRequest(JSON.stringify({ question: "q" })), context());

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("no_documents_indexed");
  });

  it("maps ai_quota_exceeded to 403", async () => {
    runAsk.mockImplementation(() =>
      rejectWith(new AskError("ai_quota_exceeded", "daily limit", 403)),
    );

    const response = await POST(askRequest(JSON.stringify({ question: "q" })), context());

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ai_quota_exceeded");
  });

  it("maps provider and retrieval failures to 502 ai_provider_failed", async () => {
    runAsk.mockImplementationOnce(() =>
      rejectWith(new AiProviderError("upstream down")),
    );
    const providerResponse = await POST(
      askRequest(JSON.stringify({ question: "q" })),
      context(),
    );
    expect(providerResponse.status).toBe(502);
    expect((await providerResponse.json()).error.code).toBe("ai_provider_failed");

    runAsk.mockImplementationOnce(() => rejectWith(new RetrieveError("rpc down")));
    const retrieveResponse = await POST(
      askRequest(JSON.stringify({ question: "q" })),
      context(),
    );
    expect(retrieveResponse.status).toBe(502);
    expect((await retrieveResponse.json()).error.code).toBe("ai_provider_failed");
  });

  it("emits a terminal error event when the generator fails mid-stream", async () => {
    async function* failing(): AsyncGenerator<AskStreamEvent> {
      yield { type: "citations", citations: [] };
      throw new AskError("record_failed", "write failed", 500);
    }
    runAsk.mockImplementation(() => failing());

    const response = await POST(askRequest(JSON.stringify({ question: "q" })), context());

    expect(response.status).toBe(200);
    const events = await readNdjson(response);
    expect(events).toEqual([
      { type: "citations", citations: [] },
      { type: "error", code: "record_failed" },
    ]);
  });
});

describe("GET /api/rooms/[id]/ask/history", () => {
  const item: AskHistoryItem = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    question: "q",
    answer: "a",
    citations: [],
    conversation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    created_at: "2026-10-01T00:00:00.000Z",
  };

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await historyGET(historyRequest(), context());
    expect(response.status).toBe(401);
    expect(listAskHistory).not.toHaveBeenCalled();
  });

  it("answers a non-member with 404", async () => {
    requireRoomMembership.mockRejectedValue(new RoomAccessError("missing"));
    const response = await historyGET(historyRequest(), context());
    expect(response.status).toBe(404);
  });

  it("returns the caller's items and the next cursor", async () => {
    listAskHistory.mockResolvedValue({
      items: [item],
      next_cursor: encodeCursor(item.created_at, item.id),
    });

    const response = await historyGET(historyRequest("?limit=10"), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toEqual([item]);
    expect(typeof body.next_cursor).toBe("string");
    expect(listAskHistory).toHaveBeenCalledWith(expect.anything(), {
      roomId: ROOM,
      limit: 10,
      cursor: undefined,
    });
  });

  it("decodes a cursor before listing", async () => {
    listAskHistory.mockResolvedValue({ items: [], next_cursor: null });
    const cursor = encodeCursor("2026-10-01T00:00:00.000Z", item.id);

    await historyGET(historyRequest(`?cursor=${encodeURIComponent(cursor)}`), context());

    expect(listAskHistory).toHaveBeenCalledWith(expect.anything(), {
      roomId: ROOM,
      limit: 20,
      cursor: { createdAt: "2026-10-01T00:00:00.000Z", id: item.id },
    });
  });

  it("rejects a malformed cursor with 400", async () => {
    const response = await historyGET(historyRequest("?cursor=zzz"), context());
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(listAskHistory).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range limit with 400", async () => {
    const response = await historyGET(historyRequest("?limit=999"), context());
    expect(response.status).toBe(400);
  });
});

describe("GET /api/rooms/[id]/ask/documents", () => {
  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await documentsGET(documentsRequest(), context());
    expect(response.status).toBe(401);
  });

  it("answers a non-member with 404", async () => {
    requireRoomMembership.mockRejectedValue(new RoomAccessError("missing"));
    const response = await documentsGET(documentsRequest(), context());
    expect(response.status).toBe(404);
  });

  it("returns the visible documents with status and chunk counts", async () => {
    const documents: AskDocument[] = [
      { resource_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Notes", status: "ready", chunks: 4 },
      { resource_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", title: "Slides", status: "pending", chunks: 0 },
    ];
    listAskDocuments.mockResolvedValue(documents);

    const response = await documentsGET(documentsRequest(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documents });
    expect(listAskDocuments).toHaveBeenCalledWith(expect.anything(), ROOM);
  });

  it("maps AskError to its status", async () => {
    listAskDocuments.mockRejectedValue(
      new AskError("documents_failed", "boom", 500),
    );
    const response = await documentsGET(documentsRequest(), context());
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("documents_failed");
  });
});
