/**
 * The ingest state machine (spec: `lib/ai/ingest.ts`, `advanceIngest`).
 *
 * Execution model: no queue, no daemon, no in-memory work. Every HTTP request
 * advances **one step** (≤ ~2 s), the database RPCs own every transition, and
 * a client that closes the tab leaves a row that is *resumable*, not broken —
 * the explicit "Index now" button and `POST /api/ai/ingest/sweep` both drive
 * the same `advanceIngest`.
 *
 * The dispatch matrix, exactly as documented in `docs/API_CONTRACTS.md`:
 *
 * | stored status | `auto`        | explicit step                 |
 * | ------------- | ------------- | ----------------------------- |
 * | ready/failed  | noop          | noop (`step_done` = requested) |
 * | extracting    | extract       | extract runs; chunk/embed noop (chunk/embed out-of-order → `step_done: null`) |
 * | chunking      | chunk         | chunk runs; embed out-of-order → null; extract already done → `step_done: "extract"` |
 * | embedding     | embed         | embed runs; extract/chunk report as done / out-of-order |
 *
 * Authorization, size and type gates live in the RPCs (`ingest_begin` and
 * friends re-check everything through `ai_resource_for_ingest`); this module
 * never trusts its own view of the world. Failures map to the published
 * error codes; provider failures leave the row at `embedding` with
 * `error_code`, never silently `ready`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifySelf } from "@/lib/notifications/write";
import {
  findResourceLocator,
} from "@/lib/resources/queries";
import { RESOURCE_BUCKET } from "@/lib/resources/types";
import { chunkDocument } from "./chunk";
import { aiConfig } from "./config";
import { extractDocument } from "./extract";
import {
  AiProviderError,
  EMBED_BATCH_SIZE,
  getProvider,
} from "./provider";
import {
  isIngestErrorCode,
  type AiDocumentStatusInfo,
  type ChunkDraft,
  type EmbeddedChunk,
  type IngestErrorCode,
  type IngestStatus,
  type IngestStep,
  type IngestStepDone,
} from "./types";
import { fetchAiUsageDaily, UsageError } from "./usage";
import { errorFields, logError } from "@/lib/server/log";

/** Published messages — one string per code, shared by route responses. */
export const INGEST_MESSAGES: Record<string, string> = {
  unauthenticated: "Sign in to index your files.",
  not_found: "That file does not exist or is not available.",
  not_resource_owner: "You can only index files you own.",
  not_member: "You can only index files in rooms you belong to.",
  too_large: "This file is too large to index.",
  unsupported_media_type: "This file type cannot be indexed yet.",
  ai_quota_exceeded:
    "The daily AI limit has been reached. Try again tomorrow.",
  ai_provider_failed: "The AI service is unavailable right now. Try again shortly.",
  ingest_failed: "The file could not be indexed. Please try again.",
  rate_limited: "Too many indexing requests — wait about a minute and try again.",
};

/** Failure carrying the HTTP status the route returns. */
export class IngestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message?: string) {
    super(message ?? INGEST_MESSAGES[code] ?? INGEST_MESSAGES.ingest_failed);
    this.name = "IngestError";
    this.code = code;
    this.status = status;
  }
}

/** Database message → published code/status. Unknown messages fail closed. */
const RPC_ERROR_MAP: Record<string, { code: string; status: number }> = {
  not_found: { code: "not_found", status: 404 },
  not_resource_owner: { code: "not_resource_owner", status: 403 },
  not_member: { code: "not_member", status: 403 },
  too_large: { code: "too_large", status: 413 },
  unsupported_media_type: { code: "unsupported_media_type", status: 415 },
  unauthenticated: { code: "unauthenticated", status: 401 },
  not_authorized: { code: "unauthenticated", status: 401 },
  ai_quota_exceeded: { code: "ai_quota_exceeded", status: 403 },
  invalid_state: { code: "ingest_failed", status: 500 },
  invalid_chunk: { code: "ingest_failed", status: 500 },
  invalid_error_code: { code: "ingest_failed", status: 500 },
  extract_failed: { code: "ingest_failed", status: 500 },
  ingest_failed: { code: "ingest_failed", status: 500 },
};

type PostgrestFailure = { code?: string; message?: string } | null;

function mapRpcError(error: PostgrestFailure): IngestError {
  const message = error?.message ?? "";
  const mapped = RPC_ERROR_MAP[message];
  if (mapped) {
    return new IngestError(mapped.code, mapped.status);
  }
  if (error?.code === "42501") {
    return new IngestError("unauthenticated", 401);
  }
  return new IngestError("ingest_failed", 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What `ingest_begin` answers; defensive parsing, no casts of `any`. */
type BeginData = {
  status: IngestStatus;
  error_code: IngestErrorCode | null;
  is_owner: boolean;
  room_id: string | null;
  title: string;
  content_type: string;
  chunk_count: number;
  embedding_tokens: number;
  model: string | null;
};

const KNOWN_STATUSES: readonly string[] = [
  "pending",
  "extracting",
  "chunking",
  "embedding",
  "ready",
  "failed",
];

function parseBegin(value: unknown): BeginData {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new IngestError("ingest_failed", 500);
  }
  const status = KNOWN_STATUSES.includes(value.status)
    ? (value.status as IngestStatus)
    : null;
  if (status === null) {
    throw new IngestError("ingest_failed", 500);
  }
  return {
    status,
    error_code: isIngestErrorCode(value.error_code) ? value.error_code : null,
    is_owner: value.is_owner === true,
    room_id: typeof value.room_id === "string" ? value.room_id : null,
    title: typeof value.title === "string" ? value.title : "",
    content_type: typeof value.content_type === "string" ? value.content_type : "",
    chunk_count: typeof value.chunk_count === "number" ? value.chunk_count : 0,
    embedding_tokens:
      typeof value.embedding_tokens === "number" ? value.embedding_tokens : 0,
    model: typeof value.model === "string" ? value.model : null,
  };
}

export type AdvanceResult = {
  status: IngestStatus;
  step_done: IngestStepDone;
  /** Present whenever the document carries a failure code. */
  error_code?: IngestErrorCode;
  chunks?: number;
  tokens?: number;
  model?: string | null;
  /** Set only when this call actually embedded (the provider actually used). */
  provider?: string;
};

export type AdvanceIngestInput = {
  resourceId: string;
  step: IngestStep;
  /** Session user — quota scope, ledger rows and self-notification target. */
  userId: string;
};

async function beginSession(
  client: SupabaseClient,
  resourceId: string,
): Promise<BeginData> {
  const { data, error } = await client.rpc("ingest_begin", {
    p_resource_id: resourceId,
  });
  if (error) {
    throw mapRpcError(error);
  }
  return parseBegin(data);
}

function noopResult(begin: BeginData, stepDone: IngestStepDone): AdvanceResult {
  const result: AdvanceResult = { status: begin.status, step_done: stepDone };
  if (begin.error_code !== null) {
    result.error_code = begin.error_code;
  }
  if (begin.status === "ready" || stepDone !== null) {
    result.chunks = begin.chunk_count;
    result.tokens = begin.embedding_tokens;
    result.model = begin.model;
  }
  return result;
}

type Resolution =
  | { kind: "noop"; stepDone: IngestStepDone }
  | { kind: "run"; action: "extract" | "chunk" | "embed" };

export function resolveIngestAction(
  status: IngestStatus,
  requested: IngestStep,
): Resolution {
  if (status === "ready" || status === "failed") {
    return { kind: "noop", stepDone: requested === "auto" ? null : requested };
  }

  if (requested === "auto") {
    if (status === "pending" || status === "extracting") {
      return { kind: "run", action: "extract" };
    }
    if (status === "chunking") {
      return { kind: "run", action: "chunk" };
    }
    return { kind: "run", action: "embed" };
  }

  if (requested === "extract") {
    if (status === "extracting" || status === "pending") {
      return { kind: "run", action: "extract" };
    }
    // Already past extraction: the step is done, re-running is a no-op.
    return { kind: "noop", stepDone: "extract" };
  }

  if (requested === "chunk") {
    if (status === "chunking") {
      return { kind: "run", action: "chunk" };
    }
    if (status === "embedding") {
      return { kind: "noop", stepDone: "chunk" };
    }
    // Extraction has not happened yet — out of order, nothing to claim.
    return { kind: "noop", stepDone: null };
  }

  // requested === "embed"
  if (status === "embedding") {
    return { kind: "run", action: "embed" };
  }
  if (status === "chunking" || status === "extracting" || status === "pending") {
    return { kind: "noop", stepDone: null };
  }
  return { kind: "noop", stepDone: "embed" };
}

/** Downloads the stored object through Storage (never an external URL). */
async function downloadObject(
  client: SupabaseClient,
  storagePath: string,
): Promise<Uint8Array> {
  const { data, error } = await client.storage
    .from(RESOURCE_BUCKET)
    .download(storagePath);

  if (error || !data) {
    logError("[ai/ingest] object read failed", {
      scope: storagePath.split("/")[0],
      error_message: error?.message ?? "no data",
    });
    throw new IngestError("ingest_failed", 500);
  }

  const buffer = await data.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Best-effort failure write: the caller's answer (e.g. `no_text_layer`) is
 * already decided, so a failed bookkeeping write is logged rather than thrown
 * — the sweep and the next explicit attempt converge on the stored state.
 */
async function markFailed(
  client: SupabaseClient,
  resourceId: string,
  errorCode: IngestErrorCode,
  status: "failed" | "embedding",
): Promise<void> {
  const { error } = await client.rpc("ingest_mark_failed", {
    p_resource_id: resourceId,
    p_error_code: errorCode,
    p_status: status,
  });
  if (error) {
    logError("[ai/ingest] mark_failed write failed:", { error_message: error.message });
  }
}

type DocumentRow = {
  status: IngestStatus;
  extracted_text: string | null;
  pending_chunks: unknown;
};

async function readDocumentRow(
  client: SupabaseClient,
  resourceId: string,
): Promise<DocumentRow | null> {
  const { data, error } = await client
    .from("study_ai_documents")
    .select("status, extracted_text, pending_chunks")
    .eq("resource_id", resourceId)
    .maybeSingle();

  if (error) {
    throw new IngestError("ingest_failed", 500);
  }
  if (!data) {
    return null;
  }
  const status = typeof data.status === "string" &&
    KNOWN_STATUSES.includes(data.status)
    ? (data.status as IngestStatus)
    : null;
  if (status === null) {
    throw new IngestError("ingest_failed", 500);
  }
  return {
    status,
    extracted_text:
      typeof data.extracted_text === "string" ? data.extracted_text : null,
    pending_chunks: data.pending_chunks ?? null,
  };
}

async function runExtract(
  client: SupabaseClient,
  input: AdvanceIngestInput,
  begin: BeginData,
): Promise<AdvanceResult> {
  const locator = await findResourceLocator(client, input.resourceId);
  if (!locator) {
    throw new IngestError("not_found", 404);
  }

  const config = aiConfig();
  const bytes = await downloadObject(client, locator.storage_path);
  // Size re-checked against the *actual* object, not just the stored row.
  if (bytes.length > config.maxIngestBytes) {
    throw new IngestError("too_large", 413);
  }

  const extracted = await extractDocument(bytes, begin.content_type);
  if (!extracted.ok) {
    if (extracted.code === "unsupported_media_type") {
      // Unreachable through the routes (`ingest_begin` gates types first) —
      // defense in depth. It is a request-level rejection, not a document
      // outcome, and the column's CHECK deliberately does not store it.
      throw new IngestError("unsupported_media_type", 415);
    }
    await markFailed(client, input.resourceId, extracted.code, "failed");
    return {
      status: "failed",
      step_done: null,
      error_code: extracted.code,
    };
  }

  const { data, error } = await client.rpc("ingest_record_extraction", {
    p_resource_id: input.resourceId,
    p_text: extracted.text,
  });
  if (error) {
    throw mapRpcError(error);
  }

  const status =
    isRecord(data) && typeof data.status === "string"
      ? (data.status as IngestStatus)
      : "chunking";
  const errorCode =
    isRecord(data) && isIngestErrorCode(data.error_code) ? data.error_code : null;

  if (status === "failed") {
    return {
      status,
      step_done: null,
      ...(errorCode ? { error_code: errorCode } : {}),
    };
  }
  return { status, step_done: "extract" };
}

async function runChunk(
  client: SupabaseClient,
  input: AdvanceIngestInput,
  begin: BeginData,
): Promise<AdvanceResult> {
  const row = await readDocumentRow(client, input.resourceId);
  if (!row) {
    throw new IngestError("not_found", 404);
  }

  const text = row.extracted_text;
  if (text === null || text.trim() === "") {
    // Transient state vanished (or never landed): restart at extraction —
    // one step this request, exactly like any other call.
    return runExtract(client, input, begin);
  }

  const drafts = chunkDocument(text, {
    pdf: begin.content_type === "application/pdf",
    markdown: begin.content_type === "text/markdown",
  });

  if (drafts.length === 0) {
    await markFailed(client, input.resourceId, "no_text_layer", "failed");
    return { status: "failed", step_done: null, error_code: "no_text_layer" };
  }

  const { data, error } = await client.rpc("ingest_record_chunks", {
    p_resource_id: input.resourceId,
    p_chunks: drafts,
  });
  if (error) {
    throw mapRpcError(error);
  }

  const chunks =
    isRecord(data) && typeof data.chunks === "number"
      ? data.chunks
      : drafts.length;
  const status =
    isRecord(data) && typeof data.status === "string"
      ? (data.status as IngestStatus)
      : "embedding";
  return { status, step_done: "chunk", chunks };
}

function normalizeDrafts(value: unknown): ChunkDraft[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  const drafts: ChunkDraft[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.ordinal !== "number" ||
      typeof entry.text !== "string" ||
      typeof entry.tokens !== "number"
    ) {
      return [];
    }
    drafts.push({
      ordinal: entry.ordinal,
      text: entry.text,
      tokens: entry.tokens,
      page_start:
        typeof entry.page_start === "number" ? entry.page_start : null,
      heading: typeof entry.heading === "string" ? entry.heading : null,
    });
  }
  return drafts;
}

async function preCheckQuota(
  client: SupabaseClient,
  input: AdvanceIngestInput,
  begin: BeginData,
  addBytes: number,
): Promise<void> {
  let usage;
  try {
    usage = await fetchAiUsageDaily(client, input.userId, begin.room_id);
  } catch (error) {
    if (error instanceof UsageError) {
      throw mapRpcError({ code: error.code, message: error.message });
    }
    throw error;
  }
  if (usage.used_bytes + addBytes > usage.limit_bytes) {
    // The RPC inside `ingest_record_chunk` re-checks (race-safe authority);
    // this pre-check exists so the provider is never called at all when the
    // cap is already spent.
    await markFailed(client, input.resourceId, "ai_quota_exceeded", "embedding");
    throw new IngestError("ai_quota_exceeded", 403);
  }
}

async function runEmbed(
  client: SupabaseClient,
  input: AdvanceIngestInput,
  begin: BeginData,
): Promise<AdvanceResult> {
  const row = await readDocumentRow(client, input.resourceId);
  if (!row) {
    throw new IngestError("not_found", 404);
  }

  const drafts = normalizeDrafts(row.pending_chunks);
  if (drafts.length === 0) {
    // Drafts lost (never written / row rewritten): back up one step. This
    // request does chunking; the next one embeds — still one step per call.
    return runChunk(client, input, begin);
  }

  const addBytes = drafts.reduce(
    (total, draft) => total + Buffer.byteLength(draft.text, "utf8"),
    0,
  );
  await preCheckQuota(client, input, begin, addBytes);

  const provider = getProvider();
  const vectors: number[][] = [];
  let tokens = 0;
  let model = "";
  let providerName = provider.name;

  try {
    for (let start = 0; start < drafts.length; start += EMBED_BATCH_SIZE) {
      const texts = drafts
        .slice(start, start + EMBED_BATCH_SIZE)
        .map((draft) => draft.text);
      const result = await provider.embed(texts);
      vectors.push(...result.vectors);
      tokens += result.tokens;
      model = result.model;
      providerName = result.provider;
    }
  } catch (error) {
    if (error instanceof AiProviderError) {
      // Spec: provider failure leaves the row `embedding` + error_code,
      // resumable by an explicit retry — never silently ready.
      await markFailed(client, input.resourceId, "ai_provider_failed", "embedding");
      throw error;
    }
    await markFailed(client, input.resourceId, "ingest_failed", "embedding");
    logError("[ai/ingest] embed step failed", errorFields(error));
    throw new IngestError("ingest_failed", 500);
  }

  if (vectors.length !== drafts.length) {
    await markFailed(client, input.resourceId, "ai_provider_failed", "embedding");
    throw new AiProviderError("provider returned an incomplete batch");
  }

  const embedded: EmbeddedChunk[] = drafts.map((draft, index) => ({
    ...draft,
    embedding: vectors[index],
  }));

  const { data, error } = await client.rpc("ingest_record_chunk", {
    p_resource_id: input.resourceId,
    p_chunks: embedded,
    p_model: model,
    p_tokens: tokens,
  });
  if (error) {
    const mapped = mapRpcError(error);
    if (mapped.code === "ai_quota_exceeded") {
      // Lost the race against a concurrent embed: record it so the UI can
      // explain, then surface the documented 403.
      await markFailed(client, input.resourceId, "ai_quota_exceeded", "embedding");
    }
    throw mapped;
  }

  if (begin.is_owner) {
    // Self-notification only (0012's producer rule), best-effort by contract:
    // the indexing result never depends on the notification write.
    await notifySelf(client, {
      type: "ai_task_complete",
      userId: input.userId,
      roomId: begin.room_id,
      payload: {
        title: "Ready for AI",
        body: begin.title
          ? `“${begin.title}” is indexed and ready to use.`
          : "Your file is indexed and ready to use.",
      },
      dedupeKey: `ai_task_complete:${input.resourceId}`,
    });
  }

  const chunkCount =
    isRecord(data) && typeof data.chunk_count === "number"
      ? data.chunk_count
      : embedded.length;
  const reportedTokens =
    isRecord(data) && typeof data.tokens === "number" ? data.tokens : tokens;
  const reportedModel =
    isRecord(data) && typeof data.model === "string" ? data.model : model;

  return {
    status: "ready",
    step_done: "embed",
    chunks: chunkCount,
    tokens: reportedTokens,
    model: reportedModel,
    provider: providerName,
  };
}

/**
 * Advances one resource's ingest state by exactly one step.
 * Throws `IngestError` (documented status codes) or `AiProviderError`
 * (`502 ai_provider_failed`); returns the 200 state payload otherwise.
 */
export async function advanceIngest(
  client: SupabaseClient,
  input: AdvanceIngestInput,
): Promise<AdvanceResult> {
  const begin = await beginSession(client, input.resourceId);
  const resolution = resolveIngestAction(begin.status, input.step);

  if (resolution.kind === "noop") {
    return noopResult(begin, resolution.stepDone);
  }

  switch (resolution.action) {
    case "extract":
      return runExtract(client, input, begin);
    case "chunk":
      return runChunk(client, input, begin);
    case "embed":
      return runEmbed(client, input, begin);
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export const SWEEP_STUCK_MINUTES = 5;

export type SweepResult = {
  picked: number;
  statuses: Array<{ resource_id: string; status: IngestStatus }>;
};

export type SweepInput = {
  userId: string;
  /** When set, only this room's stuck rows (membership checked by the route). */
  roomId: string | null;
  limit: number;
};

/**
 * Picks up stuck rows — non-terminal, no stored error, untouched for five
 * minutes — and advances each by one `auto` step.
 *
 * Eligibility comes from the partial index in migration 0013 and from RLS:
 * the query only ever sees rows the caller could already read (own personal
 * files + rooms they are in). Rows carrying an `error_code` are excluded on
 * purpose: those wait for a human to press "Index now", not for a sweep.
 */
export async function sweepIngests(
  client: SupabaseClient,
  input: SweepInput,
): Promise<SweepResult> {
  const cutoff = new Date(
    Date.now() - SWEEP_STUCK_MINUTES * 60_000,
  ).toISOString();

  // One select shape (with the `study_resources` embed) keeps supabase-js's
  // generated row type a single literal; the embed doubles as the room filter
  // (`!inner`) and is a no-op narrowing when `roomId` is null — every visible
  // document row's resource is visible too, so the join drops nothing.
  let query = client
    .from("study_ai_documents")
    .select(
      "resource_id, status, updated_at, study_resources!inner(room_id)",
    )
    .neq("status", "ready")
    .neq("status", "failed")
    .is("error_code", null)
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(input.limit);

  if (input.roomId !== null) {
    query = query.eq("study_resources.room_id", input.roomId);
  }

  const { data, error } = await query;
  if (error) {
    logError("[ai/ingest] sweep list failed:", { error_message: error.message });
    throw new IngestError("ingest_failed", 500);
  }

  const rows = data ?? [];
  const statuses: SweepResult["statuses"] = [];

  for (const row of rows) {
    const resourceId = String(row.resource_id);
    try {
      const result = await advanceIngest(client, {
        resourceId,
        step: "auto",
        userId: input.userId,
      });
      statuses.push({ resource_id: resourceId, status: result.status });
    } catch {
      // One bad row must not abandon the rest of the sweep: report what the
      // row actually looks like now (RLS-visible read) and continue.
      const fallback = await readStatusOnly(client, resourceId);
      statuses.push({ resource_id: resourceId, status: fallback });
    }
  }

  return { picked: rows.length, statuses };
}

async function readStatusOnly(
  client: SupabaseClient,
  resourceId: string,
): Promise<IngestStatus> {
  try {
    const row = await readDocumentRow(client, resourceId);
    return row?.status ?? "failed";
  } catch {
    return "failed";
  }
}

export type { AiDocumentStatusInfo };
