import {
  chatTokensUsedToday,
  countReadyDocuments,
  CHAT_DAILY_TOKEN_LIMIT,
  findRecentDuplicate,
  parseStoredCitations,
  runAsk,
  toStoredCitations,
  type AskStreamEvent,
} from "@/lib/ai/ask";
import { MOCK_COMPLETION } from "@/lib/ai/providers/mock";
import { describe, expect, it, vi } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Result = { data: unknown; error: { message: string } | null };

/** Minimal chainable stand-in for the Supabase query builder. */
function chainable(result: Result) {
  const builder: Record<string, unknown> = {};
  const methods = [
    "select",
    "eq",
    "in",
    "gt",
    "order",
    "limit",
    "gte",
  ];
  for (const method of methods) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (
    onFulfilled: (value: Result) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  return builder;
}

const MATCH_ROWS = [
  {
    resource_id: DOC,
    chunk_id: "chunk-1",
    ordinal: 0,
    text: "Torque equals rate of change of angular momentum.",
    title: "Rotational motion notes",
    room_id: ROOM,
    score: 0.8,
    page_start: 3,
    heading: null,
  },
];

type ClientScript = {
  readyDocs?: Result;
  history?: Result;
  usage?: Result;
  recordQa?: Result;
  /** Rows `match_document_chunks` should return; defaults to one ready chunk. */
  matchRows?: unknown[] | null;
};

type FakeClient = {
  client: Parameters<typeof runAsk>[0];
  rpc: ReturnType<typeof vi.fn>;
};

function fakeClient(script: ClientScript): FakeClient {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "match_document_chunks") {
      return { data: script.matchRows ?? MATCH_ROWS, error: null };
    }
    if (fn === "record_qa") {
      return script.recordQa ?? { data: null, error: null };
    }
    throw new Error(`unexpected rpc: ${fn}`);
  });
  const from = vi.fn((table: string) => {
    if (table === "study_ai_documents" || table === "study_resources") {
      return chainable(script.readyDocs ?? {
        data: [{ id: DOC, study_ai_documents: { status: "ready" } }],
        error: null,
      });
    }
    if (table === "study_qa") {
      return chainable(script.history ?? { data: [], error: null });
    }
    if (table === "ai_usage") {
      return chainable(script.usage ?? { data: [], error: null });
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return { client: { from, rpc } as unknown as Parameters<typeof runAsk>[0], rpc };
}

async function collect(
  client: Parameters<typeof runAsk>[0],
  overrides: Partial<Parameters<typeof runAsk>[1]> = {},
): Promise<AskStreamEvent[]> {
  const events: AskStreamEvent[] = [];
  for await (const event of runAsk(client, {
    roomId: ROOM,
    userId: USER,
    question: "What is torque?",
    conversationId: CONVERSATION,
    ...overrides,
  })) {
    events.push(event);
  }
  return events;
}

describe("countReadyDocuments", () => {
  it("counts ready rows visible to the caller in the given room", async () => {
    const readyEmbed = { status: "ready" };
    const { client } = fakeClient({
      readyDocs: {
        data: [
          { id: DOC, study_ai_documents: readyEmbed },
          { id: DOC, study_ai_documents: readyEmbed },
          { id: DOC, study_ai_documents: { status: "pending" } },
        ],
        error: null,
      },
    });
    expect(await countReadyDocuments(client, ROOM)).toBe(2);
  });

  it("filters resourceIds in code against the room rows", async () => {
    const { client } = fakeClient({
      readyDocs: {
        data: [
          { id: DOC, study_ai_documents: { status: "ready" } },
          { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", study_ai_documents: { status: "ready" } },
        ],
        error: null,
      },
    });
    expect(await countReadyDocuments(client, ROOM, [DOC])).toBe(1);
  });

  it("surfaces a database failure as AskError 500", async () => {
    const { client } = fakeClient({
      readyDocs: { data: null, error: { message: "boom" } },
    });
    await expect(countReadyDocuments(client, ROOM)).rejects.toMatchObject({
      code: "documents_failed",
      status: 500,
    });
  });
});

describe("chatTokensUsedToday", () => {
  it("sums the caller's own chat_tokens rows", async () => {
    const { client } = fakeClient({
      usage: { data: [{ amount: 40 }, { amount: 60 }], error: null },
    });
    expect(await chatTokensUsedToday(client)).toBe(100);
  });
});

describe("findRecentDuplicate", () => {
  it("returns null when nothing matches", async () => {
    const { client } = fakeClient({ history: { data: [], error: null } });
    expect(
      await findRecentDuplicate(client, {
        roomId: ROOM,
        conversationId: CONVERSATION,
        question: "q",
      }),
    ).toBeNull();
  });

  it("replays a matching recent row", async () => {
    const { client } = fakeClient({
      history: {
        data: [
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            conversation_id: CONVERSATION,
            answer: "prior answer",
            citations: [],
          },
        ],
        error: null,
      },
    });
    const duplicate = await findRecentDuplicate(client, {
      roomId: ROOM,
      conversationId: CONVERSATION,
      question: "q",
    });
    expect(duplicate?.answer).toBe("prior answer");
  });
});

describe("parseStoredCitations / toStoredCitations", () => {
  it("drops malformed entries instead of failing the read", () => {
    expect(
      parseStoredCitations([
        { n: 1, resource_id: DOC, title: "T", href: "/rooms/x" },
        { n: "two" },
        null,
        "nope",
      ]),
    ).toEqual([{ n: 1, resource_id: DOC, title: "T", href: "/rooms/x" }]);
  });

  it("numbers stored citations 1-based from the retrieval order", () => {
    const stored = toStoredCitations([
      { resourceId: DOC, title: "A", href: "/resources", pages: [1] },
      { resourceId: DOC, title: "A", href: "/resources" },
    ]);
    expect(stored.map((citation) => citation.n)).toEqual([1, 2]);
    expect(stored[0].pages).toEqual([1]);
  });
});

describe("runAsk", () => {
  it("answers 409-shaped when no indexed document is ready", async () => {
    const { client } = fakeClient({ readyDocs: { data: [], error: null } });
    await expect(collect(client)).rejects.toMatchObject({
      code: "no_documents_indexed",
      status: 409,
    });
  });

  it("replays a recent duplicate without calling the provider", async () => {
    const { client } = fakeClient({
      history: {
        data: [
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            conversation_id: CONVERSATION,
            answer: "prior",
            citations: [
              { n: 1, resource_id: DOC, title: "Notes", href: `/rooms/${ROOM}` },
            ],
          },
        ],
        error: null,
      },
    });
    const events = await collect(client);
    expect(events[0]).toEqual({
      type: "citations",
      citations: [
        { n: 1, resource_id: DOC, title: "Notes", href: `/rooms/${ROOM}` },
      ],
    });
    expect(events[1]).toEqual({ type: "delta", text: "prior" });
    expect(events[2]).toMatchObject({ type: "done", qa_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
  });

  it("fails 403-shaped when the daily chat budget is already spent", async () => {
    const { client } = fakeClient({
      usage: { data: [{ amount: CHAT_DAILY_TOKEN_LIMIT }], error: null },
    });
    await expect(collect(client)).rejects.toMatchObject({
      code: "ai_quota_exceeded",
      status: 403,
    });
  });

  it("answers from retrieved chunks, persists via record_qa, and streams citations → delta → done", async () => {
    const { client, rpc } = fakeClient({
      recordQa: {
        data: {
          qa_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          chat_used_today: 12,
          chat_limit: CHAT_DAILY_TOKEN_LIMIT,
          deduped: false,
        },
        error: null,
      },
    });
    const events = await collect(client);

    expect(events.map((event) => event.type)).toEqual(["citations", "delta", "done"]);
    const citations = events[0];
    if (citations.type !== "citations") throw new Error("expected citations");
    expect(citations.citations.length).toBeGreaterThan(0);
    const done = events[2];
    if (done.type !== "done") throw new Error("expected done");
    expect(done.qa_id).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(done.usage.retrieved_chunks).toBeGreaterThan(0);
    expect(done.usage.chat_limit).toBe(CHAT_DAILY_TOKEN_LIMIT);

    const recordCall = rpc.mock.calls.find(
      (call) => call[0] === "record_qa",
    );
    expect(recordCall).toBeDefined();
    const args = recordCall?.[1] as Record<string, unknown>;
    expect(args.p_room_id).toBe(ROOM);
    expect(args.p_conversation_id).toBe(CONVERSATION);
    expect(String(args.p_answer)).toContain(MOCK_COMPLETION.trim());
    expect(args.p_retrieved_chunks).toBeGreaterThan(0);
    expect(args.p_citations).toEqual(citations.citations);
  });

  it("maps a record_qa quota rejection to the 403 AskError", async () => {
    const { client } = fakeClient({
      recordQa: { data: null, error: { message: "ai_quota_exceeded" } },
    });
    await expect(collect(client)).rejects.toMatchObject({
      code: "ai_quota_exceeded",
      status: 403,
    });
  });
});
