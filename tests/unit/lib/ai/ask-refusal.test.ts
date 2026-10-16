import { CHAT_DAILY_TOKEN_LIMIT, REFUSAL_ANSWER, runAsk, type AskStreamEvent } from "@/lib/ai/ask";
import { getProvider } from "@/lib/ai/provider";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/provider")>();
  return {
    ...original,
    getProvider: vi.fn(() => ({
      name: "mock",
      embed: original.getProvider().embed,
      complete: vi.fn(),
    })),
  };
});

const ROOM = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Result = { data: unknown; error: { message: string } | null };

function chainable(result: Result) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "gt", "order", "limit", "gte"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (
    onFulfilled: (value: Result) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  return builder;
}

type FakeClient = {
  client: Parameters<typeof runAsk>[0];
  rpc: ReturnType<typeof vi.fn>;
};

function fakeClient(): FakeClient {
  const rpc = vi.fn(async () => ({
    data: {
      qa_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      chat_used_today: 0,
      chat_limit: CHAT_DAILY_TOKEN_LIMIT,
      deduped: false,
    },
    error: null,
  }));
  const from = vi.fn((table: string) => {
    if (table === "study_ai_documents" || table === "study_resources") {
      return chainable({
        data: [
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            study_ai_documents: { status: "ready" },
          },
        ],
        error: null,
      });
    }
    if (table === "study_qa") {
      return chainable({ data: [], error: null });
    }
    if (table === "ai_usage") {
      return chainable({ data: [], error: null });
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return { client: { from, rpc } as unknown as Parameters<typeof runAsk>[0], rpc };
}

describe("runAsk refusal path", () => {
  it("answers with the canned refusal, calls no completion, records zero chunks", async () => {
    // Force empty retrieval by making the provider emit a zero-width batch —
    // retrieve() returns an empty result rather than throwing.
    vi.mocked(getProvider).mockReturnValueOnce({
      name: "mock",
      embed: vi.fn(async () => ({
        vectors: [],
        tokens: 3,
        model: "mock-embedding-1536",
        provider: "mock" as const,
      })),
      complete: vi.fn(),
    });

    const { client, rpc } = fakeClient();
    const events: AskStreamEvent[] = [];
    for await (const event of runAsk(client, {
      roomId: ROOM,
      userId: USER,
      question: "unanswerable",
      conversationId: CONVERSATION,
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["citations", "delta", "done"]);
    const citations = events[0];
    if (citations.type !== "citations") throw new Error("expected citations");
    expect(citations.citations).toEqual([]);
    const delta = events[1];
    if (delta.type !== "delta") throw new Error("expected delta");
    expect(delta.text).toBe(REFUSAL_ANSWER);

    const recordCall = rpc.mock.calls.find((call) => call[0] === "record_qa");
    const args = recordCall?.[1] as Record<string, unknown>;
    expect(args.p_answer).toBe(REFUSAL_ANSWER);
    expect(args.p_retrieved_chunks).toBe(0);
    expect(args.p_citations).toEqual([]);
    // The query embedding's tokens are still accounted for.
    expect(args.p_retrieval_tokens).toBe(3);
    // No completion was requested.
    const complete = vi.mocked(getProvider).mock.results[0].value.complete;
    expect(complete).not.toHaveBeenCalled();
  });
});
