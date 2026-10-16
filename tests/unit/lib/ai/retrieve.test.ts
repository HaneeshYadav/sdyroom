import {
  hrefForResource,
  retrieve,
  RetrieveError,
  RETRIEVAL_DEFAULT_THRESHOLD,
  RETRIEVAL_DEFAULT_TOP_K,
  RETRIEVAL_MAX_TOP_K,
} from "@/lib/ai/retrieve";
import { describe, expect, it, vi } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";
const OTHER_ROOM = "22222222-2222-4222-8222-222222222222";
const DOC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Row = Record<string, unknown>;

function row(overrides: Row): Row {
  return {
    resource_id: DOC_A,
    chunk_id: "chunk-1",
    ordinal: 0,
    text: "Torque equals rate of change of angular momentum.",
    title: "Rotational motion notes",
    room_id: null,
    score: 0.8,
    page_start: 3,
    heading: null,
    ...overrides,
  };
}

function fakeClient(rows: unknown, error: { message: string } | null = null) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    rpc: vi.fn(async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { data: rows, error };
    }),
  };
  return { client, calls };
}

describe("hrefForResource", () => {
  it("links personal files to the library and room files to the room (routes that exist today)", () => {
    expect(hrefForResource(null)).toBe("/resources");
    expect(hrefForResource(ROOM)).toBe(`/rooms/${ROOM}`);
    expect(hrefForResource(OTHER_ROOM)).toBe(`/rooms/${OTHER_ROOM}`);
  });
});

describe("retrieve", () => {
  it("embeds the query and passes scope, limit and threshold to the RPC", async () => {
    const { client, calls } = fakeClient([]);
    await retrieve(client as never, { roomId: ROOM, query: "angular momentum" });

    expect(calls).toHaveLength(1);
    const args = calls[0];
    expect(args.p_room_id).toBe(ROOM);
    expect(args.p_limit).toBe(RETRIEVAL_DEFAULT_TOP_K);
    expect(args.p_threshold).toBe(RETRIEVAL_DEFAULT_THRESHOLD);
    const vector = String(args.p_query_embedding);
    expect(vector.startsWith("[")).toBe(true);
    expect(vector.endsWith("]")).toBe(true);
    expect(vector.split(",").length).toBe(1536);
  });

  it("returns an empty result (not an error) when nothing matches", async () => {
    const { client } = fakeClient([]);
    const result = await retrieve(client as never, {
      roomId: null,
      query: "nothing relevant",
    });
    expect(result).toEqual({ chunks: [], citations: [] });
  });

  it("throws RetrieveError when the RPC fails", async () => {
    const { client } = fakeClient(null, { message: "boom" });
    await expect(
      retrieve(client as never, { roomId: null, query: "x" }),
    ).rejects.toThrow(RetrieveError);
  });

  it("re-filters by threshold and keeps the top-k window, best score first", async () => {
    const rows = [
      row({ chunk_id: "low", score: 0.1 }), // below threshold → dropped
      row({ chunk_id: "mid", score: 0.5 }),
      row({ chunk_id: "best", score: 0.9 }),
      row({ chunk_id: "also-low", score: RETRIEVAL_DEFAULT_THRESHOLD - 0.01 }),
    ];
    const { client } = fakeClient(rows);
    const result = await retrieve(client as never, { roomId: null, query: "q" });

    expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(["best", "mid"]);
    expect(result.chunks[0].score).toBeGreaterThanOrEqual(result.chunks[1].score);
  });

  it("clamps topK into 1..50 and accepts fractional input as floored", async () => {
    const { client, calls } = fakeClient([]);
    await retrieve(client as never, { roomId: null, query: "q", topK: 0 });
    await retrieve(client as never, { roomId: null, query: "q", topK: 999.7 });
    await retrieve(client as never, { roomId: null, query: "q", topK: 12.9 });
    expect(calls.map((args) => args.p_limit)).toEqual([
      1,
      RETRIEVAL_MAX_TOP_K,
      12,
    ]);
  });

  it("builds one citation per resource in best-first order with 1-based numbers", async () => {
    const rows = [
      row({
        resource_id: DOC_B,
        chunk_id: "b1",
        score: 0.9,
        title: "Lab report",
        page_start: null,
      }),
      row({ resource_id: DOC_A, chunk_id: "a1", score: 0.8, page_start: 2 }),
      row({
        resource_id: DOC_B,
        chunk_id: "b2",
        score: 0.7,
        page_start: null,
        title: "Lab report",
      }),
    ];
    const { client } = fakeClient(rows);
    const result = await retrieve(client as never, { roomId: null, query: "q" });

    expect(result.citations).toEqual([
      { resourceId: DOC_B, title: "Lab report", href: "/resources" },
      {
        resourceId: DOC_A,
        title: "Rotational motion notes",
        href: "/resources",
        pages: [2],
      },
    ]);
    expect(result.chunks.map((chunk) => chunk.citation.n)).toEqual([1, 2, 1]);
    expect(result.chunks[0].citation.href).toBe("/resources");
    expect(result.chunks[2].citation).toMatchObject({
      n: 1,
      resourceId: DOC_B,
      title: "Lab report",
    });
  });

  it("merges distinct pages of one resource into its citation", async () => {
    const rows = [
      row({ chunk_id: "c1", page_start: 1 }),
      row({ chunk_id: "c2", page_start: 4 }),
      row({ chunk_id: "c3", page_start: 1 }),
    ];
    const { client } = fakeClient(rows);
    const result = await retrieve(client as never, { roomId: null, query: "q" });

    expect(result.citations[0].pages).toEqual([1, 4]);
    expect(result.chunks.map((chunk) => chunk.page)).toEqual([1, 4, 1]);
  });

  it("gives room documents their room deep link", async () => {
    const rows = [row({ room_id: ROOM })];
    const { client } = fakeClient(rows);
    const result = await retrieve(client as never, { roomId: ROOM, query: "q" });
    expect(result.citations[0].href).toBe(`/rooms/${ROOM}`);
    expect(result.chunks[0].citation.href).toBe(`/rooms/${ROOM}`);
  });

  it("skips malformed rows rather than failing the whole retrieval", async () => {
    const rows = [row({ chunk_id: "good" }), { nope: true }, null];
    const { client } = fakeClient(rows);
    const result = await retrieve(client as never, { roomId: null, query: "q" });
    expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(["good"]);
  });

  it("keeps heading and score on each chunk for downstream prompts", async () => {
    const rows = [row({ heading: "Chapter 3", score: 0.77, text: "body text" })];
    const { client } = fakeClient(rows);
    const result = await retrieve(client as never, { roomId: null, query: "q" });
    expect(result.chunks[0]).toMatchObject({
      text: "body text",
      score: 0.77,
      heading: "Chapter 3",
    });
  });
});
