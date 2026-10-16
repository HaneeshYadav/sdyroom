import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as aiIngestPost } from "@/app/api/ai/ingest/[resourceId]/route";
import { POST as aiSweepPost } from "@/app/api/ai/ingest/sweep/route";
import { GET as aiUsageGet } from "@/app/api/ai/usage/route";
import { GET as resourcesGet, POST as resourcesPost } from "@/app/api/resources/route";
import { mockEmbedding } from "@/lib/ai/providers/mock";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { createRoomSchema } from "@/lib/validation/rooms";
import { readFileSync } from "node:fs";
import { psql } from "./helpers/admin";
import { callApi, callApiWithParams, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

const DAILY_LIMIT = 52_428_800;
const INGEST_RATE_MAX = 30;

type AiInfo = { status: string; error_code: string | null } | null;

type Resource = {
  id: string;
  title: string;
  content_type: string;
  room_id: string | null;
  /** Absent on the upload response (no document row exists yet). */
  ai?: AiInfo;
  is_owner?: boolean;
};

type MatchRow = { resource_id: string; chunk_id: string; score: number; text: string };

type IngestBody = Record<string, unknown>;

function fileOf(name: string, bytes: Uint8Array, type: string): File {
  return new File([bytes as BlobPart], name, { type });
}

function textFile(name: string, text: string): File {
  return fileOf(name, new TextEncoder().encode(text), "text/plain");
}

function fixture(relative: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../e2e/fixtures/${relative}`, import.meta.url)),
  );
}

async function upload(
  user: TestUser,
  fields: Record<string, string>,
  file: File,
): Promise<Resource> {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }

  await seedSession(user.email, user.password);
  const response = await callApi(resourcesPost, {
    path: "/api/resources",
    method: "POST",
    form,
  });
  expect(response.status).toBe(201);
  const body = await readJson(response);
  return body.resource as Resource;
}

function ingest(resourceId: string, body?: unknown): Promise<Response> {
  return callApiWithParams(
    aiIngestPost,
    {
      path: `/api/ai/ingest/${resourceId}`,
      method: "POST",
      ...(body === undefined ? {} : { body }),
    },
    { resourceId },
  );
}

async function ingestJson(
  resourceId: string,
  body?: unknown,
): Promise<{ status: number; body: IngestBody }> {
  const response = await ingest(resourceId, body);
  return { status: response.status, body: await readJson(response) };
}

/** Drives the published one-step-per-request loop until a terminal state. */
async function driveToTerminal(
  user: TestUser,
  resourceId: string,
  maxSteps = 8,
): Promise<IngestBody> {
  await seedSession(user.email, user.password);
  const stepDone: unknown[] = [];
  let last: IngestBody = {};
  for (let index = 0; index < maxSteps; index += 1) {
    const { status, body } = await ingestJson(resourceId);
    expect(status).toBe(200);
    last = body;
    stepDone.push(body.step_done);
    if (body.status === "ready" || body.status === "failed") {
      break;
    }
  }
  expect(["ready", "failed"]).toContain(last.status);
  if (last.status === "ready") {
    expect(stepDone).toEqual(["extract", "chunk", "embed"]);
  } else {
    expect(stepDone.at(-1)).toBeNull();
  }
  return last;
}

async function listAs(user: TestUser, query = ""): Promise<Resource[]> {
  await seedSession(user.email, user.password);
  const response = await callApi(resourcesGet, { path: `/api/resources${query}` });
  expect(response.status).toBe(200);
  const body = await readJson(response);
  return body.resources as Resource[];
}

function queryEmbedding(label: string): string {
  return `[${mockEmbedding(label).join(",")}]`;
}

async function matchChunks(
  user: TestUser,
  roomId: string | null,
): Promise<MatchRow[]> {
  const { data, error } = await user.client.rpc("match_document_chunks", {
    p_room_id: roomId,
    p_query_embedding: queryEmbedding("rotational dynamics torque"),
    p_limit: 8,
    p_threshold: 0.2,
  });
  expect(error).toBeNull();
  return (data ?? []) as MatchRow[];
}

function chunkCount(resourceId: string): number {
  return Number(
    psql(
      `select count(*) from public.document_chunks where resource_id = '${resourceId}';`,
    ).trim(),
  );
}

function docRow(resourceId: string): Record<string, unknown> {
  const line = psql(
    `select status || '|' || coalesce(error_code, '-') || '|' || chunk_count ` +
      `from public.study_ai_documents where resource_id = '${resourceId}';`,
  ).trim();
  const [status, errorCode, count] = line.split("|");
  return { status, error_code: errorCode, chunk_count: Number(count) };
}

let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let dave: TestUser;
let erin: TestUser;
let eve: TestUser;

let aliceDoc = "";
let roomDoc = "";
let roomId = "";

const savedAiEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const key of ["AI_PROVIDER", "AI_API_KEY"] as const) {
    savedAiEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  // The suite must never spend: pin the deterministic provider regardless of
  // what a local .env.local holds, exactly like CI (no key → mock).
  process.env.AI_PROVIDER = "mock";

  [alice, bob, carol, dave, erin, eve] = await Promise.all([
    createUser("ai-alice"),
    createUser("ai-bob"),
    createUser("ai-carol"),
    createUser("ai-dave"),
    createUser("ai-erin"),
    createUser("ai-eve"),
  ]);

  await Promise.all(
    [alice, bob, carol, dave, erin, eve].map((user, index) =>
      createProfile(user.client, user.id, uniqueAlias(`AI${index}`)),
    ),
  );
});

afterAll(async () => {
  for (const key of ["AI_PROVIDER", "AI_API_KEY"] as const) {
    const value = savedAiEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearCookies();
  await deleteUsers([alice, bob, carol, dave, erin, eve]);
});

describe("schema foundation", () => {
  it("runs pgvector with the fixed 1536-wide column", () => {
    expect(psql("select extname from pg_extension where extname = 'vector';")).toBe(
      "vector",
    );
    expect(
      psql(
        "select format_type(a.atttypid, a.atttypmod) from pg_attribute a " +
          "where a.attrelid = 'public.document_chunks'::regclass " +
          "and a.attname = 'embedding';",
      ),
    ).toMatch(/vector/);
  });
});

describe("owner end-to-end ingest", () => {
  it("ingests a text-layer PDF through the one-step loop to ready", async () => {
    const resource = await upload(
      alice,
      { title: "Rotational motion notes" },
      fileOf("rotational-motion.pdf", fixture("rotational-motion.pdf"), "application/pdf"),
    );
    aliceDoc = resource.id;
    expect(resource.ai ?? null).toBeNull();

    const final = await driveToTerminal(alice, aliceDoc);

    expect(final).toMatchObject({
      status: "ready",
      step_done: "embed",
      provider: "mock",
      model: "mock-embedding-1536",
    });
    expect(Number(final.chunks)).toBeGreaterThanOrEqual(1);
    expect(Number(final.tokens)).toBeGreaterThan(0);
  });

  it("stores every chunk with a 1536-dimensional vector and a 64-char hash", () => {
    expect(chunkCount(aliceDoc)).toBeGreaterThanOrEqual(1);
    expect(
      psql(
        `select min(vector_dims(embedding)) || '-' || max(vector_dims(embedding)) ` +
          `from public.document_chunks where resource_id = '${aliceDoc}';`,
      ),
    ).toBe("1536-1536");
    expect(
      psql(
        `select length(chunk_hash) from public.document_chunks ` +
          `where resource_id = '${aliceDoc}' limit 1;`,
      ),
    ).toBe("64");
    expect(docRow(aliceDoc)).toMatchObject({ status: "ready", error_code: "-" });
    expect(Number(docRow(aliceDoc).chunk_count)).toBe(chunkCount(aliceDoc));
  });

  it("answers repeat calls with idempotent no-ops and no duplicate rows", async () => {
    const before = chunkCount(aliceDoc);
    await seedSession(alice.email, alice.password);

    const auto = await ingestJson(aliceDoc);
    expect(auto.status).toBe(200);
    expect(auto.body).toMatchObject({ status: "ready", step_done: null });

    const embed = await ingestJson(aliceDoc, { step: "embed" });
    expect(embed.status).toBe(200);
    expect(embed.body).toMatchObject({ status: "ready", step_done: "embed" });

    const extract = await ingestJson(aliceDoc, { step: "extract" });
    expect(extract.status).toBe(200);
    expect(extract.body).toMatchObject({ status: "ready", step_done: "extract" });

    expect(chunkCount(aliceDoc)).toBe(before);
  });

  it("exposes status and ownership on the resource list", async () => {
    const resources = await listAs(alice);
    const row = resources.find((resource) => resource.id === aliceDoc);
    expect(row?.ai).toEqual({ status: "ready", error_code: null });
    expect(row?.is_owner).toBe(true);
  });

  it("reports today's spend and the active provider on GET /api/ai/usage", async () => {
    await seedSession(alice.email, alice.password);
    const response = await callApi(aiUsageGet, { path: "/api/ai/usage" });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({
      limit_bytes: DAILY_LIMIT,
      provider: "mock",
    });
    expect(Number(body.used_bytes)).toBeGreaterThan(0);
    expect(Number(body.used_tokens)).toBeGreaterThan(0);
  });

  it("answers 404 for a resource that does not exist", async () => {
    await seedSession(alice.email, alice.password);
    const missing = await ingestJson("99999999-9999-4999-8999-999999999999");
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body).code).toBe("not_found");
  });

  it("rejects an oversized row with 413 at the database gate", async () => {
    const originalSize = Number(
      psql(
        `select size_bytes from public.study_resources where id = '${aliceDoc}';`,
      ).trim(),
    );
    await seedSession(alice.email, alice.password);
    // PR 10's upload cap is a CHECK constraint at the same 20 MiB ceiling as
    // the ingest gate, so the stored row can only outgrow it by lifting the
    // constraint for exactly this test — the defense-in-depth branch inside
    // ai_resource_for_ingest is otherwise unreachable.
    psql(
      "alter table public.study_resources drop constraint study_resources_size;",
    );
    try {
      psql(
        `update public.study_resources set size_bytes = 30000000 where id = '${aliceDoc}';`,
      );
      const { status, body } = await ingestJson(aliceDoc);
      expect(status).toBe(413);
      expect(errorOf(body).code).toBe("too_large");
    } finally {
      psql(
        `update public.study_resources set size_bytes = ${originalSize} where id = '${aliceDoc}';`,
      );
      psql(
        "alter table public.study_resources add constraint study_resources_size " +
          "check (size_bytes >= 1 and size_bytes <= 20971520);",
      );
    }
  });
});

describe("authorization", () => {
  it("answers anonymous callers with 401 before any database work", async () => {
    clearCookies();
    const { status, body } = await ingestJson(aliceDoc);
    expect(status).toBe(401);
    expect(errorOf(body).code).toBe("unauthenticated");
  });

  it("refuses a non-owner of a personal file with 403", async () => {
    await seedSession(bob.email, bob.password);
    const { status, body } = await ingestJson(aliceDoc);
    expect(status).toBe(403);
    expect(errorOf(body).code).toBe("not_resource_owner");
  });

  it("refuses an unindexable content type with 415 and creates no document row", async () => {
    const png = fileOf(
      "diagram.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "image/png",
    );
    const resource = await upload(bob, { title: "Circuit diagram" }, png);

    await seedSession(bob.email, bob.password);
    const { status, body } = await ingestJson(resource.id);
    expect(status).toBe(415);
    expect(errorOf(body).code).toBe("unsupported_media_type");
    expect(
      psql(
        `select count(*) from public.study_ai_documents where resource_id = '${resource.id}';`,
      ).trim(),
    ).toBe("0");
  });

  it("refuses sweeps without a session", async () => {
    clearCookies();
    const response = await callApi(aiSweepPost, {
      path: "/api/ai/ingest/sweep",
      method: "POST",
      body: {},
    });
    expect(response.status).toBe(401);
  });
});

describe("retrieval authorization (match_document_chunks)", () => {
  it("returns the owner's personal chunks to the owner only", async () => {
    const rows = await matchChunks(alice, null);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => row.resource_id === aliceDoc)).toBe(true);

    const stranger = await matchChunks(bob, null);
    expect(stranger).toEqual([]);
  });

  it("never returns rows for a document that is not ready", async () => {
    const before = await matchChunks(alice, null);
    expect(before.length).toBeGreaterThanOrEqual(1);

    psql(
      `update public.study_ai_documents set status = 'embedding' where resource_id = '${aliceDoc}';`,
    );
    try {
      expect(await matchChunks(alice, null)).toEqual([]);
    } finally {
      psql(
        `update public.study_ai_documents set status = 'ready' where resource_id = '${aliceDoc}';`,
      );
    }
    expect((await matchChunks(alice, null)).length).toBeGreaterThanOrEqual(1);
  });

  it("scopes room chunks to members and refuses non-member ingest", async () => {
    roomId = (
      await createRoom(
        carol.client,
        createRoomSchema.parse({ name: uniqueName("AI Room"), capacity: 4 }),
      )
    ).id;

    const roomResource = await upload(
      carol,
      { title: "Room handout", room_id: roomId },
      textFile("handout.txt", "Chapter 3 tutorial: angular momentum conservation."),
    );
    roomDoc = roomResource.id;

    const final = await driveToTerminal(carol, roomDoc);
    expect(final).toMatchObject({ status: "ready", provider: "mock" });

    const memberRows = await matchChunks(carol, roomId);
    expect(memberRows.length).toBeGreaterThanOrEqual(1);
    expect(memberRows.every((row) => row.resource_id === roomDoc)).toBe(true);

    // The same room document is invisible in a personal scope.
    expect(await matchChunks(carol, null)).toEqual([]);

    // A non-member sees nothing and cannot start ingesting either.
    expect(await matchChunks(dave, roomId)).toEqual([]);

    await seedSession(dave.email, dave.password);
    const denied = await ingestJson(roomDoc);
    expect(denied.status).toBe(403);
    expect(errorOf(denied.body).code).toBe("not_member");
  });

  it("sweeps refuse a room the caller does not belong to", async () => {
    await seedSession(dave.email, dave.password);
    const response = await callApi(aiSweepPost, {
      path: "/api/ai/ingest/sweep",
      method: "POST",
      body: { room_id: roomId },
    });
    expect(response.status).toBe(404);
    expect(errorOf(await readJson(response)).code).toBe("not_found");
  });
});

describe("table writes are RPC-only", () => {
  it("denies direct PostgREST writes to document_chunks and study_ai_documents", async () => {
    const deniedInsert = await alice.client.from("document_chunks").insert({
      resource_id: aliceDoc,
      ordinal: 99,
      text: "forged chunk",
      tokens: 2,
      embedding: queryEmbedding("forged"),
    });
    expect(deniedInsert.error).toBeTruthy();

    const { data: chunkRows } = await alice.client
      .from("document_chunks")
      .select("id")
      .eq("resource_id", aliceDoc)
      .limit(1);
    const chunkId = (chunkRows as Array<{ id: string }>)[0]?.id;
    expect(chunkId).toBeTruthy();

    const deniedUpdate = await alice.client
      .from("document_chunks")
      .update({ text: "rewritten" })
      .eq("id", chunkId);
    expect(deniedUpdate.error).toBeTruthy();

    const deniedDelete = await alice.client
      .from("document_chunks")
      .delete()
      .eq("id", chunkId);
    expect(deniedDelete.error).toBeTruthy();

    const deniedDocInsert = await alice.client
      .from("study_ai_documents")
      .insert({ resource_id: roomDoc });
    expect(deniedDocInsert.error).toBeTruthy();

    expect(chunkCount(aliceDoc)).toBeGreaterThanOrEqual(1);
  });

  it("withholds the embedding column from every select", async () => {
    // Grants are column-level: a granted-column select succeeds and never
    // contains the vector…
    const granted = await alice.client
      .from("document_chunks")
      .select("id, resource_id, ordinal, text, tokens, chunk_hash")
      .eq("resource_id", aliceDoc)
      .limit(1);
    expect(granted.error).toBeNull();
    const row = (granted.data as Array<Record<string, unknown>>)[0];
    expect(row).toBeTruthy();
    expect("embedding" in row).toBe(false);

    // …while an ungranted column — including a wildcard that would expand to
    // it — is refused outright.
    const explicit = await alice.client
      .from("document_chunks")
      .select("embedding")
      .eq("resource_id", aliceDoc)
      .limit(1);
    expect(explicit.error).toBeTruthy();

    const wildcard = await alice.client
      .from("document_chunks")
      .select("*")
      .eq("resource_id", aliceDoc)
      .limit(1);
    expect(wildcard.error).toBeTruthy();
    expect(wildcard.error?.code).toBe("42501");
  });
});

describe("document outcomes and recovery", () => {
  it("reports a scanned/drawing-only PDF as failed / no_text_layer, a 200 state", async () => {
    const resource = await upload(
      erin,
      { title: "Scanned notes" },
      fileOf("drawing-only.pdf", fixture("drawing-only.pdf"), "application/pdf"),
    );

    await seedSession(erin.email, erin.password);
    const { status, body } = await ingestJson(resource.id);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "failed",
      step_done: null,
      error_code: "no_text_layer",
    });

    const listed = (await listAs(erin)).find((row) => row.id === resource.id);
    expect(listed?.ai).toEqual({ status: "failed", error_code: "no_text_layer" });
  });

  it("sweeps a stuck, error-free row by exactly one step and skips the rest", async () => {
    const resource = await upload(
      erin,
      { title: "Interrupted indexing" },
      textFile("interrupted.txt", "Torque notes left behind by a closed tab."),
    );

    const staged = await ingestJson(resource.id, { step: "extract" });
    expect(staged.status).toBe(200);
    expect(staged.body).toMatchObject({ status: "chunking", step_done: "extract" });

    // Young rows are never picked.
    await seedSession(erin.email, erin.password);
    const young = await callApi(aiSweepPost, {
      path: "/api/ai/ingest/sweep",
      method: "POST",
      body: {},
    });
    expect(young.status).toBe(200);
    expect((await readJson(young)).picked).toBe(0);

    psql(
      `update public.study_ai_documents set updated_at = now() - interval '10 minutes' ` +
        `where resource_id = '${resource.id}';`,
    );

    const swept = await callApi(aiSweepPost, {
      path: "/api/ai/ingest/sweep",
      method: "POST",
      body: {},
    });
    expect(swept.status).toBe(200);
    const body = await readJson(swept);
    expect(body.picked).toBe(1);
    expect(body.statuses).toEqual([
      { resource_id: resource.id, status: "embedding" },
    ]);
  });

  it("hits the daily cap with 403 without touching the ledger, then resumes to ready", async () => {
    const resource = await upload(
      erin,
      { title: "Quota resume" },
      textFile("quota.txt", "Angular momentum will be embedded exactly once."),
    );

    const extract = await ingestJson(resource.id, { step: "extract" });
    expect(extract.body).toMatchObject({ status: "chunking", step_done: "extract" });
    const chunk = await ingestJson(resource.id, { step: "chunk" });
    expect(chunk.body).toMatchObject({ status: "embedding", step_done: "chunk" });

    psql(
      `insert into public.ai_usage (room_id, user_id, kind, amount) ` +
        `values (null, '${erin.id}', 'embed_bytes', ${DAILY_LIMIT});`,
    );
    try {
      const refused = await ingestJson(resource.id);
      expect(refused.status).toBe(403);
      expect(errorOf(refused.body).code).toBe("ai_quota_exceeded");

      // The ledger is unchanged: the provider was never called, so nothing
      // could have been recorded on top of the seeded cap.
      const used = Number(
        psql(
          `select coalesce(sum(amount), 0) from public.ai_usage ` +
            `where user_id = '${erin.id}' and kind = 'embed_bytes';`,
        ).trim(),
      );
      expect(used).toBe(DAILY_LIMIT);

      // The failure is stored, resumable, and surfaces in the resource list.
      expect(docRow(resource.id)).toMatchObject({
        status: "embedding",
        error_code: "ai_quota_exceeded",
      });
      const listed = (await listAs(erin)).find((row) => row.id === resource.id);
      expect(listed?.ai).toEqual({ status: "embedding", error_code: "ai_quota_exceeded" });
    } finally {
      psql(`delete from public.ai_usage where user_id = '${erin.id}';`);
    }

    // Cap cleared: the identical request now completes — no duplicate side
    // effects, exactly one ledger pair, chunk_count matching the rows.
    const resumed = await ingestJson(resource.id);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: "ready", step_done: "embed" });

    const rows = Number(
      psql(
        `select count(*) from public.ai_usage where user_id = '${erin.id}';`,
      ).trim(),
    );
    expect(rows).toBe(2);
    expect(chunkCount(resource.id)).toBeGreaterThanOrEqual(1);
    expect(Number(docRow(resource.id).chunk_count)).toBe(chunkCount(resource.id));
    expect(docRow(resource.id)).toMatchObject({ status: "ready", error_code: "-" });

    psql(`delete from public.ai_usage where user_id = '${erin.id}';`);
  });
});

describe("rate limiting", () => {
  it("answers an abusive ingest caller with 429 rate_limited", async () => {
    const resource = await upload(
      eve,
      { title: "Rate limit target" },
      textFile("rate.txt", "One bounded step per request, thirty per minute."),
    );
    const final = await driveToTerminal(eve, resource.id);
    expect(final.status).toBe("ready");

    // Fill the published window directly through the same RPC the route uses.
    for (let index = 0; index < INGEST_RATE_MAX; index += 1) {
      const { error } = await eve.client.rpc("rate_limit_take", {
        p_key: `ingest:user:${eve.id}`,
        p_max: INGEST_RATE_MAX,
        p_window: "60 seconds",
      });
      expect(error).toBeNull();
    }

    const response = await ingest(resource.id);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const body = await readJson(response);
    expect(errorOf(body).code).toBe("rate_limited");
  });
});
