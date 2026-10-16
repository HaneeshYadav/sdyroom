import { AiProviderError } from "@/lib/ai/provider";
import {
  advanceIngest,
  IngestError,
  resolveIngestAction,
  sweepIngests,
} from "@/lib/ai/ingest";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findResourceLocator, providerEmbed } = vi.hoisted(() => ({
  findResourceLocator: vi.fn(),
  providerEmbed: vi.fn(),
}));

vi.mock("@/lib/resources/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/queries")>()),
  findResourceLocator,
}));

vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  return {
    ...actual,
    getProvider: () => ({
      name: "mock" as const,
      embed: providerEmbed,
      complete: vi.fn(),
    }),
  };
});

const RESOURCE = "44444444-4444-4444-8444-444444444444";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM = "11111111-1111-4111-8111-111111111111";
const STORAGE_PATH = `personal/${USER}/note.txt`;

type RpcError = { code?: string; message: string };
type RpcHandler = (args: Record<string, unknown>) => { data?: unknown; error?: RpcError | null };

function baseBegin(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      status: "pending",
      error_code: null,
      is_owner: true,
      room_id: null,
      title: "Rotational motion notes",
      content_type: "text/plain",
      chunk_count: 0,
      embedding_tokens: 0,
      model: null,
      ...overrides,
    },
    error: null,
  };
}

type FakeOptions = {
  rpc?: Partial<Record<string, RpcHandler>>;
  documentRow?: { status: string; extracted_text: string | null; pending_chunks: unknown } | null;
  downloadBytes?: Uint8Array;
  downloadError?: string;
  sweepRows?: Array<{ resource_id: string; status: string; updated_at: string }>;
  sweepError?: string;
};

function fakeClient(options: FakeOptions = {}) {
  const { rpc = {}, documentRow = null, sweepError } = options;
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  const documentResult = {
    data: documentRow,
    error: documentRow === undefined ? { message: "not found" } : null,
  };

  const builderState = { neq: 0 };
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    neq: vi.fn(() => {
      builderState.neq += 1;
      return builder;
    }),
    is: vi.fn(() => builder),
    lt: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => documentResult),
    then: (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve(
        sweepError
          ? { data: null, error: { message: sweepError } }
          : { data: options.sweepRows ?? [], error: null },
      ).then(onFulfilled, onRejected),
  };

  const bytes = options.downloadBytes ?? new TextEncoder().encode("hello world");
  const bucket = {
    download: vi.fn(async () =>
      options.downloadError
        ? { data: null, error: { message: options.downloadError } }
        : { data: new Blob([bytes as BlobPart]), error: null },
    ),
  };

  const client = {
    from: vi.fn(() => builder),
    storage: { from: vi.fn(() => bucket) },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ fn, args });
      const handler = rpc[fn];
      if (handler) {
        return handler(args);
      }
      if (fn === "push_notification") {
        return { data: { code: "created" }, error: null };
      }
      return { data: null, error: null };
    }),
  };

  return { client, rpcCalls, bucket };
}

const AI_ENV_KEYS = ["AI_MAX_INGEST_BYTES", "AI_PROVIDER", "AI_API_KEY"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of AI_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  findResourceLocator.mockReset().mockResolvedValue({ storage_path: STORAGE_PATH });
  providerEmbed.mockReset();
  providerEmbed.mockImplementation(async (texts: string[]) => ({
    vectors: texts.map(() => Array.from({ length: 1536 }, () => 0.5)),
    tokens: 7,
    model: "mock-embedding-1536",
    provider: "mock" as const,
  }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of AI_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe("resolveIngestAction — the published dispatch matrix", () => {
  const cases: Array<
    [status: string, requested: string, expected: string]
  > = [
    ["ready", "auto", "noop:null"],
    ["ready", "extract", "noop:extract"],
    ["ready", "chunk", "noop:chunk"],
    ["ready", "embed", "noop:embed"],
    ["failed", "auto", "noop:null"],
    ["failed", "extract", "noop:extract"],
    ["failed", "chunk", "noop:chunk"],
    ["failed", "embed", "noop:embed"],
    ["pending", "auto", "run:extract"],
    ["pending", "extract", "run:extract"],
    ["pending", "chunk", "noop:null"],
    ["pending", "embed", "noop:null"],
    ["extracting", "auto", "run:extract"],
    ["extracting", "extract", "run:extract"],
    ["extracting", "chunk", "noop:null"],
    ["extracting", "embed", "noop:null"],
    ["chunking", "auto", "run:chunk"],
    ["chunking", "extract", "noop:extract"],
    ["chunking", "chunk", "run:chunk"],
    ["chunking", "embed", "noop:null"],
    ["embedding", "auto", "run:embed"],
    ["embedding", "extract", "noop:extract"],
    ["embedding", "chunk", "noop:chunk"],
    ["embedding", "embed", "run:embed"],
  ];

  for (const [status, requested, expected] of cases) {
    it(`${status} + ${requested} → ${expected}`, () => {
      const resolution = resolveIngestAction(
        status as never,
        requested as never,
      );
      const actual =
        resolution.kind === "run"
          ? `run:${resolution.action}`
          : `noop:${resolution.stepDone}`;
      expect(actual).toBe(expected);
    });
  }
});

describe("advanceIngest — no-ops", () => {
  it("returns the stored counts for an already-ready document", async () => {
    const { client } = fakeClient({
      rpc: {
        ingest_begin: () =>
          baseBegin({
            status: "ready",
            chunk_count: 5,
            embedding_tokens: 40,
            model: "mock-embedding-1536",
          }),
      },
    });

    const result = await advanceIngest(client as never, {
      resourceId: RESOURCE,
      step: "auto",
      userId: USER,
    });

    expect(result).toEqual({
      status: "ready",
      step_done: null,
      chunks: 5,
      tokens: 40,
      model: "mock-embedding-1536",
    });
  });

  it("carries the document outcome of a failed row without re-running work", async () => {
    const { client, rpcCalls } = fakeClient({
      rpc: {
        ingest_begin: () =>
          baseBegin({ status: "failed", error_code: "no_text_layer" }),
      },
    });

    const result = await advanceIngest(client as never, {
      resourceId: RESOURCE,
      step: "extract",
      userId: USER,
    });

    expect(result).toEqual({
      status: "failed",
      step_done: "extract",
      error_code: "no_text_layer",
      chunks: 0,
      tokens: 0,
      model: null,
    });
    expect(rpcCalls.map((call) => call.fn)).toEqual(["ingest_begin"]);
  });
});

describe("advanceIngest — database error mapping", () => {
  const mappings: Array<[message: string, code: string, status: number]> = [
    ["not_found", "not_found", 404],
    ["not_resource_owner", "not_resource_owner", 403],
    ["not_member", "not_member", 403],
    ["too_large", "too_large", 413],
    ["unsupported_media_type", "unsupported_media_type", 415],
    ["ai_quota_exceeded", "ai_quota_exceeded", 403],
    ["invalid_state", "ingest_failed", 500],
    ["something never seen", "ingest_failed", 500],
  ];

  for (const [message, code, status] of mappings) {
    it(`maps "${message}" to ${code}/${status}`, async () => {
      const { client } = fakeClient({
        rpc: {
          ingest_begin: () => ({ data: null, error: { message } }),
        },
      });
      const error = await advanceIngest(client as never, {
        resourceId: RESOURCE,
        step: "auto",
        userId: USER,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(IngestError);
      expect(error).toMatchObject({ code, status });
    });
  }

  it("maps a RLS denial (42501) to unauthenticated", async () => {
    const { client } = fakeClient({
      rpc: {
        ingest_begin: () => ({
          data: null,
          error: { code: "42501", message: "permission denied for table" },
        }),
      },
    });
    await expect(
      advanceIngest(client as never, {
        resourceId: RESOURCE,
        step: "auto",
        userId: USER,
      }),
    ).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  });

  it("fails closed when the RPC answers with an unknown status", async () => {
    const { client } = fakeClient({
      rpc: { ingest_begin: () => ({ data: { status: "weird" }, error: null }) },
    });
    await expect(
      advanceIngest(client as never, {
        resourceId: RESOURCE,
        step: "auto",
        userId: USER,
      }),
    ).rejects.toMatchObject({ code: "ingest_failed", status: 500 });
  });
});

describe("advanceIngest — extract step", () => {
  it("downloads the stored object and records extracted text", async () => {
    const { client, rpcCalls } = fakeClient({
      rpc: {
        ingest_begin: () => baseBegin({ status: "extracting" }),
        ingest_record_extraction: () => ({
          data: { status: "chunking", error_code: null },
          error: null,
        }),
      },
      downloadBytes: new TextEncoder().encode("Torque is rotational force."),
    });

    const result = await advanceIngest(client as never, {
      resourceId: RESOURCE,
      step: "auto",
      userId: USER,
    });

    expect(result).toEqual({ status: "chunking", step_done: "extract" });
    const record = rpcCalls.find((call) => call.fn === "ingest_record_extraction");
    expect(record?.args).toEqual({
      p_resource_id: RESOURCE,
      p_text: "Torque is rotational force.",
    });
  });

  it("surfaces a document outcome (no_text_layer) the database decided", async () => {
    const { client, rpcCalls } = fakeClient({
      rpc: {
        ingest_begin: () => baseBegin({ status: "extracting", content_type: "application/pdf" }),
        ingest_record_extraction: () => ({
          data: { status: "failed", error_code: "no_text_layer" },
          error: null,
        }),
      },
      // A drawing-only PDF extracts to "" — the database turns that into
      // no_text_layer, which this step simply reports.
      downloadBytes: readFileSync(
        new URL("./fixtures/drawing-only.pdf", import.meta.url),
      ),
    });

    const result = await advanceIngest(client as never, {
      resourceId: RESOURCE,
      step: "auto",
      userId: USER,
    });

    expect(result).toEqual({
      status: "failed",
      step_done: null,
      error_code: "no_text_layer",
    });
    expect(rpcCalls.some((call) => call.fn === "ingest_mark_failed")).toBe(false);
  });

  it("rejects an object larger than the ingest ceiling", async () => {
    process.env.AI_MAX_INGEST_BYTES = "1024";
    const { client, rpcCalls } = fakeClient({
      rpc: { ingest_begin: () => baseBegin({ status: "extracting" }) },
      downloadBytes: new Uint8Array(2048),
    });

    await expect(
      advanceIngest(client as never, {
        resourceId: RESOURCE,
        step: "auto",
        userId: USER,
      }),
    ).rejects.toMatchObject({ code: "too_large", status: 413 });
    expect(rpcCalls.some((call) => call.fn === "ingest_record_extraction")).toBe(false);
  });

  it("answers a missing storage object with ingest_failed and never logs the path or user", async () => {
    const errorSpy = vi.mocked(console.error);
    const { client } = fakeClient({
      rpc: { ingest_begin: () => baseBegin({ status: "extracting" }) },
      downloadError: "Object not found",
    });

    await expect(
      advanceIngest(client as never, {
        resourceId: RESOURCE,
        step: "auto",
        userId: USER,
      }),
    ).rejects.toMatchObject({ code: "ingest_failed", status: 500 });

    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("[ai/ingest] object read failed:");
    expect(logged).not.toContain(STORAGE_PATH);
    expect(logged).not.toContain(USER);
    expect(logged).not.toContain(RESOURCE);
  });

  it("answers a resource that vanished with 404", async () => {
    findResourceLocator.mockResolvedValue(null);
    const { client } = fakeClient({
      rpc: { ingest_begin: () => baseBegin({ status: "extracting" }) },
    });

    await expect(
      advanceIngest(client as never, {
        resourceId: RESOURCE,
        step: "auto",
        userId: USER,
      }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("advanceIngest — chunk step", () => {
  it("turns stored text into drafts and asks the DB to stage them", async () => {
    const text = ["page one", "page two", "page three"].join("\f");
    const { client, rpcCalls } = fakeClient({
      rpc: {
        ingest_begin: () =>
          baseBegin({ status: "chunking", content_type: "application/pdf" }),
        ingest_record_chunks: () => ({
          data: { status: "embedding", chunks: 3 },
          error: null,
        }),
      },
      documentRow: {
        status: "chunking",
        extracted_text: text,
        pending_chunks: null,
      },
    });

    const result = await advanceIngest(client as never, {
      resourceId: RESOURCE,
      step: "auto",
      userId: USER,
    });

    expect(result).toEqual({
      status: "embedding",
      step_done: "chunk",
      chunks: 3,
    });
    const record = rpcCalls.find((call) => call.fn === "ingest_record_chunks");
    const drafts = record?.args.p_chunks as Array<Record<string, unknown>>;
    expect(drafts).toHaveLength(3);
    expect(drafts.map((draft) => draft.ordinal)).toEqual([0, 1, 2]);
    expect(drafts.map((draft) => draft.page_start)).toEqual([1, 2, 3]);
  });

  it("restarts at extraction when the stored text vanished", async () => {
    const { client, rpcCalls } = fakeClient({
      rpc: {
        ingest_begin: () => baseBegin({ status: "chunking" }),
        ingest_record_extraction: () => ({
          data: { status: "chunking", error_code: null },
          error: null,
        }),
      },
      documentRow: { status: "chunking", extracted_text: null, pending_chunks: null },
    });

    const result = await advanceIngest(client as never, {
      resourceId: RESOURCE,
      step: "auto",
      userId: USER,
    });

    expect(result).toEqual({ status: "chunking", step_done: "extract" });
    expect(rpcCalls.some((call) => call.fn === "ingest_record_chunks")).toBe(false);
  });
});

describe("advanceIngest — embed step", () => {
  const DRAFTS = [
    { ordinal: 0, text: "Torque is rotational force.", tokens: 7, page_start: 1, heading: null },
    { ordinal: 1, text: "Angular momentum is conserved.", tokens: 8, page_start: 2, heading: null },
  ];

  function embedSetup(overrides: Partial<FakeOptions> = {}) {
    const { rpc: rpcOverride, documentRow: rowOverride, ...rest } = overrides;
    return fakeClient({
      ...rest,
      rpc: {
        ingest_begin: () =>
          baseBegin({ status: "embedding", is_owner: true, room_id: null }),
        ai_usage_daily: () => ({
          data: {
            scope: "user",
            used_bytes: 100,
            used_tokens: 10,
            limit_bytes: 50 * 1024 * 1024,
            day_start: new Date().toISOString(),
          },
          error: null,
        }),
        ingest_record_chunk: () => ({
          data: { chunk_count: 2, tokens: 14, model: "mock-embedding-1536" },
          error: null,
        }),
        ...(rpcOverride ?? {}),
      },
      documentRow:
        rowOverride !== undefined
          ? rowOverride
          : {
              status: "embedding",
              extracted_text: "Torque is rotational force.",
              pending_chunks: DRAFTS,
            },
    });
  }

  it("embeds the drafts, stores them and notifies the owner", async () => {
    const { client, rpcCalls } = embedSetup();

    const result = await advanceIngest(client as never, {
      resourceId: RESOURCE,
      step: "auto",
      userId: USER,
    });

    expect(result).toEqual({
      status: "ready",
      step_done: "embed",
      chunks: 2,
      tokens: 14,
      model: "mock-embedding-1536",
      provider: "mock",
    });
    expect(providerEmbed).toHaveBeenCalledTimes(1);

    const record = rpcCalls.find((call) => call.fn === "ingest_record_chunk");
    const chunks = record?.args.p_chunks as Array<Record<string, unknown>>;
    expect(chunks).toHaveLength(2);
    expect(chunks[0].embedding).toHaveLength(1536);
    expect(record?.args).toMatchObject({
      p_resource_id: RESOURCE,
      p_model: "mock-embedding-1536",
      p_tokens: 7, // the provider's own report for this batch
    });

    const push = rpcCalls.find((call) => call.fn === "push_notification");
    expect(push?.args).toMatchObject({
      p_user_id: USER,
      p_type: "ai_task_complete",
      p_dedupe_key: `ai_task_complete:${RESOURCE}`,
    });
  });

  it("never calls the provider when the daily cap is already spent", async () => {
    const { client, rpcCalls } = embedSetup({
      rpc: {
        ai_usage_daily: () => ({
          data: {
            scope: "user",
            used_bytes: 50 * 1024 * 1024,
            used_tokens: 99,
            limit_bytes: 50 * 1024 * 1024,
            day_start: new Date().toISOString(),
          },
          error: null,
        }),
      },
    });

    await expect(
      advanceIngest(client as never, {
        resourceId: RESOURCE,
        step: "auto",
        userId: USER,
      }),
    ).rejects.toMatchObject({ code: "ai_quota_exceeded", status: 403 });

    expect(providerEmbed).not.toHaveBeenCalled();
    expect(rpcCalls.some((call) => call.fn === "ingest_record_chunk")).toBe(false);
    const marked = rpcCalls.find((call) => call.fn === "ingest_mark_failed");
    expect(marked?.args).toMatchObject({
      p_resource_id: RESOURCE,
      p_error_code: "ai_quota_exceeded",
      p_status: "embedding",
    });
  });

  it("maps a usage-RPC auth failure to unauthenticated", async () => {
    const { client } = embedSetup({
      rpc: {
        ai_usage_daily: () => ({
          data: null,
          error: { code: "42501", message: "not_authorized" },
        }),
      },
    });

    await expect(
      advanceIngest(client as never, {
        resourceId: RESOURCE,
        step: "auto",
        userId: USER,
      }),
    ).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  });

  it("leaves the row resumable on a provider failure (never silently ready)", async () => {
    providerEmbed.mockRejectedValue(new AiProviderError("provider responded with status 500"));
    const { client, rpcCalls } = embedSetup();

    await expect(
      advanceIngest(client as never, {
        resourceId: RESOURCE,
        step: "auto",
        userId: USER,
      }),
    ).rejects.toThrow(AiProviderError);

    expect(rpcCalls.some((call) => call.fn === "ingest_record_chunk")).toBe(false);
    const marked = rpcCalls.find((call) => call.fn === "ingest_mark_failed");
    expect(marked?.args).toMatchObject({
      p_error_code: "ai_provider_failed",
      p_status: "embedding",
    });
  });

  it("treats an incomplete provider batch as a provider failure", async () => {
    providerEmbed.mockImplementation(async () => ({
      vectors: [Array.from({ length: 1536 }, () => 0.5)],
      tokens: 7,
      model: "mock-embedding-1536",
      provider: "mock" as const,
    }));
    const { client, rpcCalls } = embedSetup();

    await expect(
      advanceIngest(client as never, {
        resourceId: RESOURCE,
        step: "auto",
        userId: USER,
      }),
    ).rejects.toThrow(AiProviderError);
    expect(
      rpcCalls.find((call) => call.fn === "ingest_mark_failed")?.args,
    ).toMatchObject({ p_error_code: "ai_provider_failed" });
  });

  it("surfaces the race-safe quota refusal from the RPC", async () => {
    const { client, rpcCalls } = embedSetup({
      rpc: {
        ingest_record_chunk: () => ({
          data: null,
          error: { message: "ai_quota_exceeded" },
        }),
      },
    });

    await expect(
      advanceIngest(client as never, {
        resourceId: RESOURCE,
        step: "auto",
        userId: USER,
      }),
    ).rejects.toMatchObject({ code: "ai_quota_exceeded", status: 403 });
    expect(
      rpcCalls.find((call) => call.fn === "ingest_mark_failed")?.args,
    ).toMatchObject({ p_error_code: "ai_quota_exceeded", p_status: "embedding" });
  });

  it("backups one step when the staged drafts are gone", async () => {
    const { client, rpcCalls } = embedSetup({
      rpc: {
        ingest_record_chunks: () => ({
          data: { status: "embedding", chunks: 2 },
          error: null,
        }),
      },
      documentRow: {
        status: "embedding",
        extracted_text: "Torque is rotational force.",
        pending_chunks: null,
      },
    });

    const result = await advanceIngest(client as never, {
      resourceId: RESOURCE,
      step: "auto",
      userId: USER,
    });

    expect(result.step_done).toBe("chunk");
    expect(providerEmbed).not.toHaveBeenCalled();
    expect(rpcCalls.some((call) => call.fn === "ingest_record_chunks")).toBe(true);
  });
});

describe("sweepIngests", () => {
  it("answers with nothing when no row is eligible", async () => {
    const { client, rpcCalls } = fakeClient({ sweepRows: [] });

    const result = await sweepIngests(client as never, {
      userId: USER,
      roomId: null,
      limit: 10,
    });

    expect(result).toEqual({ picked: 0, statuses: [] });
    expect(rpcCalls).toEqual([]);
  });

  it("advances each eligible row by one auto step", async () => {
    const { client, rpcCalls } = fakeClient({
      sweepRows: [
        {
          resource_id: RESOURCE,
          status: "extracting",
          updated_at: "2026-10-01T00:00:00+00:00",
        },
      ],
      rpc: {
        ingest_begin: () => baseBegin({ status: "extracting" }),
        ingest_record_extraction: () => ({
          data: { status: "chunking", error_code: null },
          error: null,
        }),
      },
      downloadBytes: new TextEncoder().encode("swept text"),
    });

    const result = await sweepIngests(client as never, {
      userId: USER,
      roomId: ROOM,
      limit: 5,
    });

    expect(result).toEqual({
      picked: 1,
      statuses: [{ resource_id: RESOURCE, status: "chunking" }],
    });
    expect(rpcCalls.some((call) => call.fn === "ingest_begin")).toBe(true);
  });

  it("keeps sweeping when one row fails, reporting its real status", async () => {
    const { client, rpcCalls } = fakeClient({
      sweepRows: [
        {
          resource_id: RESOURCE,
          status: "embedding",
          updated_at: "2026-10-01T00:00:00+00:00",
        },
      ],
      rpc: {
        ingest_begin: () => ({ data: null, error: { message: "not_found" } }),
      },
      documentRow: { status: "embedding", extracted_text: "x", pending_chunks: [] },
    });

    const result = await sweepIngests(client as never, {
      userId: USER,
      roomId: null,
      limit: 10,
    });

    expect(result.picked).toBe(1);
    expect(result.statuses).toEqual([{ resource_id: RESOURCE, status: "embedding" }]);
    expect(rpcCalls.some((call) => call.fn === "ingest_record_chunk")).toBe(false);
  });

  it("answers an unreadable eligibility list with ingest_failed", async () => {
    const { client } = fakeClient({ sweepError: "permission denied" });

    await expect(
      sweepIngests(client as never, { userId: USER, roomId: null, limit: 10 }),
    ).rejects.toMatchObject({ code: "ingest_failed", status: 500 });
  });
});
