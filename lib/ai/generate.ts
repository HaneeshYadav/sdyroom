/**
 * Quiz/deck generation and practice orchestration (PR-14,
 * spec: docs/prs/PR-14-ai-quiz-flashcards.md).
 *
 * The routes own request concerns (session, room id, body validation, rate
 * limits) and this module owns the application pipeline: create → one bounded
 * generation step (retrieve → complete → parse-validate → `complete_artifact`)
 * plus the practice reads/writes (attempts, reviews, due cards). Generation
 * follows PR-12's resumable client-driven model: `POST …/generate` creates a
 * `generating` row and the client immediately drives `…/step`, which does
 * exactly one provider call — same shape as the ingest step route.
 *
 * Invariants (unit- and integration-tested):
 *   * only documents RLS already lets the caller read can enter an artifact —
 *     `create_artifact` re-checks each id, and retrieval narrows never widens;
 *   * the answer key never leaves the server before an attempt is submitted,
 *     and scoring happens inside `record_attempt`, not in the client;
 *   * malformed model output fails the artifact (`ai_provider_failed`) and
 *     is never persisted as `ready`;
 *   * chat spend joins PR 12's ledger through `complete_artifact`, which
 *     re-enforces the per-user daily cap in the database.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { chatTokensUsedToday, CHAT_DAILY_TOKEN_LIMIT } from "./ask";
import { notifySelf } from "@/lib/notifications/write";
import { getProvider } from "./provider";
import {
  applyGenerationContextBudget,
  buildGenerationMessages,
  deckMaxOutputTokens,
  quizMaxOutputTokens,
  type GenerationMode,
} from "./prompts/generate";
import {
  parseDeckPayload,
  parseQuizPayload,
  GenerationValidationError,
  type DeckPayload,
  type QuizPayload,
} from "./quiz/validate";
import { retrieve, type CitationRef } from "./retrieve";
import { estimateTokens } from "./tokens";
import type { FlashcardGrade } from "./srs";
import { toStoredCitations, type StoredCitation } from "./ask";

/** Ask failures that map to an HTTP status in the routes. */
export type GenerateErrorCode =
  | "no_documents_indexed"
  | "ai_quota_exceeded"
  | "artifact_not_ready"
  | "not_creator"
  | "not_found"
  | "validation"
  | "artifacts_failed"
  | "generate_failed"
  | "attempts_failed"
  | "review_failed";

export class GenerateError extends Error {
  readonly code: GenerateErrorCode;
  readonly status: number;

  constructor(code: GenerateErrorCode, message: string, status: number) {
    super(message);
    this.name = "GenerateError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Maps SECURITY DEFINER error messages (0019 raises bare strings) to typed
 * HTTP failures. `fallback` is the 500 code for the calling route.
 */
export function mapRpcError(
  error: { message: string },
  fallback: GenerateErrorCode,
  fallbackMessage: string,
): GenerateError {
  const message = error.message;
  if (message.includes("unauthenticated")) {
    return new GenerateError("not_found", "Sign in to continue.", 401);
  }
  if (message.includes("ai_quota_exceeded")) {
    return new GenerateError(
      "ai_quota_exceeded",
      "You have reached your daily AI limit. Try again tomorrow.",
      403,
    );
  }
  if (message.includes("not_creator")) {
    return new GenerateError(
      "not_creator",
      "Only the person who generated this can change or delete it.",
      403,
    );
  }
  if (message.includes("artifact_not_ready")) {
    return new GenerateError(
      "artifact_not_ready",
      "That quiz or deck is not ready yet.",
      409,
    );
  }
  if (message.includes("no_documents_indexed")) {
    return new GenerateError(
      "no_documents_indexed",
      "Index at least one document before generating.",
      409,
    );
  }
  if (message.includes("artifact_failed")) {
    return new GenerateError(
      "generate_failed",
      "That generation already failed. Generate a new one instead.",
      500,
    );
  }
  if (message.includes("validation")) {
    return new GenerateError("validation", "That request was not valid.", 400);
  }
  if (message.includes("not_found")) {
    return new GenerateError(
      "not_found",
      "That item does not exist or is not available.",
      404,
    );
  }
  return new GenerateError(fallback, fallbackMessage, 500);
}

// ---------------------------------------------------------------------------
// Artifact reads
// ---------------------------------------------------------------------------

export type ArtifactSummary = {
  id: string;
  room_id: string;
  creator_id: string;
  kind: "quiz" | "deck";
  status: "generating" | "ready" | "failed";
  error_code: string | null;
  difficulty: "easy" | "medium" | "hard";
  question_count: number | null;
  card_count: number | null;
  created_at: string;
  href: string;
  is_creator: boolean;
};

export type ArtifactDetail = ArtifactSummary & {
  payload: QuizPayloadWithSources | DeckPayloadWithSources | null;
  model: string | null;
  resource_ids: string[];
};

/** Server-built citation index stored alongside the model payload. */
export type ArtifactPayloadSources = { sources: StoredCitation[] };
export type QuizPayloadWithSources = QuizPayload & ArtifactPayloadSources;
export type DeckPayloadWithSources = DeckPayload & ArtifactPayloadSources;

export function artifactHref(
  roomId: string,
  artifactId: string,
  kind: "quiz" | "deck",
): string {
  return kind === "quiz"
    ? `/rooms/${roomId}/quizzes/${artifactId}`
    : `/rooms/${roomId}/decks/${artifactId}`;
}

const ARTIFACT_SUMMARY_COLUMNS =
  "id, room_id, creator_id, kind, status, error_code, difficulty, question_count, card_count, created_at";

function toSummary(row: Record<string, unknown>, viewerId: string): ArtifactSummary {
  const kind = row.kind === "deck" ? "deck" : "quiz";
  const id = String(row.id);
  const roomId = String(row.room_id);
  return {
    id,
    room_id: roomId,
    creator_id: String(row.creator_id),
    kind,
    status: (row.status as ArtifactSummary["status"]) ?? "generating",
    error_code: typeof row.error_code === "string" ? row.error_code : null,
    difficulty: (row.difficulty as ArtifactSummary["difficulty"]) ?? "medium",
    question_count: typeof row.question_count === "number" ? row.question_count : null,
    card_count: typeof row.card_count === "number" ? row.card_count : null,
    created_at: String(row.created_at),
    href: artifactHref(roomId, id, kind),
    is_creator: String(row.creator_id) === viewerId,
  };
}

/**
 * The room's artifacts, newest first, visible to the caller (RLS: room
 * members). `kind` narrows the listing for the two library filters.
 */
export async function listArtifacts(
  client: SupabaseClient,
  input: { roomId: string; viewerId: string; kind?: "quiz" | "deck" },
): Promise<ArtifactSummary[]> {
  let query = client
    .from("study_artifacts")
    .select(ARTIFACT_SUMMARY_COLUMNS)
    .eq("room_id", input.roomId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (input.kind) {
    query = query.eq("kind", input.kind);
  }
  const { data, error } = await query;
  if (error) {
    throw new GenerateError(
      "artifacts_failed",
      `artifact list failed: ${error.message}`,
      500,
    );
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map((row) => toSummary(row as Record<string, unknown>, input.viewerId));
}

/**
 * One artifact with its full payload, for a member of the room (404 parity
 * with a missing room for non-members — RLS returns nothing).
 */
export async function getArtifact(
  client: SupabaseClient,
  input: { roomId: string; artifactId: string; viewerId: string },
): Promise<ArtifactDetail> {
  const { data, error } = await client
    .from("study_artifacts")
    .select(`${ARTIFACT_SUMMARY_COLUMNS}, payload, model, resource_ids`)
    .eq("room_id", input.roomId)
    .eq("id", input.artifactId)
    .maybeSingle();
  if (error) {
    throw new GenerateError(
      "artifacts_failed",
      `artifact read failed: ${error.message}`,
      500,
    );
  }
  if (!data) {
    throw new GenerateError(
      "not_found",
      "That quiz or deck does not exist or is not available.",
      404,
    );
  }

  const row = data as Record<string, unknown>;
  const summary = toSummary(row, input.viewerId);
  const payload = parseArtifactPayload(row.payload, summary.kind);
  return {
    ...summary,
    payload,
    model: typeof row.model === "string" ? row.model : null,
    resource_ids: Array.isArray(row.resource_ids)
      ? row.resource_ids.map(String)
      : [],
  };
}

/**
 * Defensive read of a stored payload. The row was validated at complete
 * time; this only re-checks the array shapes the UI depends on so a corrupt
 * row degrades to `null` (UI shows an honest error) instead of a crash.
 */
export function parseArtifactPayload(
  value: unknown,
  kind: "quiz" | "deck",
): QuizPayloadWithSources | DeckPayloadWithSources | null {
  if (!isRecord(value)) {
    return null;
  }
  const sources = Array.isArray(value.sources)
    ? (value.sources as StoredCitation[])
    : [];
  if (kind === "quiz") {
    const parsed = parseQuizPayload(JSON.stringify(value), {
      expectedCount: Array.isArray(value.questions) ? value.questions.length : -1,
      sourceCount: Number.MAX_SAFE_INTEGER,
    });
    return { ...parsed, sources };
  }
  const parsed = parseDeckPayload(JSON.stringify(value), {
    expectedCount: Array.isArray(value.cards) ? value.cards.length : -1,
    sourceCount: Number.MAX_SAFE_INTEGER,
  });
  return { ...parsed, sources };
}

// ---------------------------------------------------------------------------
// Create (POST …/generate)
// ---------------------------------------------------------------------------

export type CreateArtifactInput = {
  roomId: string;
  kind: "quiz" | "deck";
  difficulty: "easy" | "medium" | "hard";
  count: number;
  resourceIds: string[] | undefined;
};

/**
 * Resolves the resource ids to pin on the artifact.
 *
 * `create_artifact` requires an explicit, non-empty `resource_ids` array —
 * pinning the exact documents a generation was grounded in is a provenance
 * guarantee, not an optional nicety. A caller that omits the filter (the UI's
 * "generate from this room" default) therefore resolves to every currently
 * ready document in the room; RLS scopes the lookup to resources the caller
 * can already read, and `create_artifact` re-validates each id inside the
 * database, so this convenience can never widen access.
 */
async function resolveResourceIdsForRoom(
  client: SupabaseClient,
  roomId: string,
  requested: string[] | undefined,
): Promise<string[]> {
  if (requested && requested.length > 0) {
    return requested;
  }
  const { data, error } = await client
    .from("study_resources")
    .select("id, study_ai_documents(status)")
    .eq("room_id", roomId);
  if (error) {
    // Same 500 surface the caller already sees when `countReadyDocuments`
    // fails — a lookup problem, not a caller mistake.
    throw new GenerateError(
      "generate_failed",
      `document status check failed: ${error.message}`,
      500,
    );
  }
  const rows: unknown[] = Array.isArray(data) ? data : [];
  return rows
    .filter((row) => {
      if (!isRecord(row) || typeof row.id !== "string") {
        return false;
      }
      // `study_ai_documents` is a to-one relationship, so PostgREST embeds a
      // single object — but tolerate an array shape the same way
      // `countReadyDocuments` does, so both call sites stay in agreement.
      const ai = isRecord(row.study_ai_documents)
        ? row.study_ai_documents
        : null;
      const aiRow = Array.isArray(ai)
        ? (ai[0] as Record<string, unknown> | undefined)
        : ai;
      return aiRow?.status === "ready";
    })
    .map((row) => (row as { id: string }).id);
}

export type CreatedArtifact = {
  id: string;
  kind: "quiz" | "deck";
  status: "generating";
  href: string;
};

/**
 * Creates a `generating` artifact. The indexed-documents gate and the daily
 * chat-cap pre-check run here (409/403 before any provider call);
 * `create_artifact` re-checks membership, the resource accessibility of every
 * id, and readiness inside the database.
 */
export async function createArtifact(
  client: SupabaseClient,
  input: CreateArtifactInput,
): Promise<CreatedArtifact> {
  // Pin the exact resource set first. `create_artifact` rejects an empty
  // `resource_ids`, so an omitted filter resolves to the room's currently
  // ready documents rather than arriving as null.
  const resourceIds = await resolveResourceIdsForRoom(
    client,
    input.roomId,
    input.resourceIds,
  );
  if (resourceIds.length === 0) {
    throw new GenerateError(
      "no_documents_indexed",
      "Index at least one document before generating.",
      409,
    );
  }

  // Fail fast (before spending the daily-chat quota) when a requested id is
  // not a ready document of this room. `create_artifact` re-checks both
  // accessibility and readiness inside the database, so this is a fast-path
  // guard, not the security boundary — but it also keeps a forged or foreign
  // id from reaching the RPC's readiness clause and masquerading as
  // `no_documents_indexed`.
  const pinned = await client
    .from("study_resources")
    .select("id, study_ai_documents(status)")
    .eq("room_id", input.roomId)
    .in("id", resourceIds);
  if (pinned.error) {
    throw new GenerateError(
      "generate_failed",
      `document status check failed: ${pinned.error.message}`,
      500,
    );
  }
  const readyPinned = new Set(
    (Array.isArray(pinned.data) ? pinned.data : [])
      .filter((row) => {
        if (!isRecord(row)) return false;
        const ai = isRecord(row.study_ai_documents)
          ? row.study_ai_documents
          : null;
        const aiRow = Array.isArray(ai)
          ? (ai[0] as Record<string, unknown> | undefined)
          : ai;
        return aiRow?.status === "ready";
      })
      .map((row) => (row as { id: string }).id),
  );
  if (resourceIds.some((id) => !readyPinned.has(id))) {
    throw new GenerateError(
      "no_documents_indexed",
      "Index at least one document before generating.",
      409,
    );
  }

  const usedToday = await chatTokensUsedToday(client);
  if (usedToday >= CHAT_DAILY_TOKEN_LIMIT) {
    throw new GenerateError(
      "ai_quota_exceeded",
      "You have reached your daily AI limit. Try again tomorrow.",
      403,
    );
  }

  const { data, error } = await client.rpc("create_artifact", {
    p_room_id: input.roomId,
    p_kind: input.kind,
    p_difficulty: input.difficulty,
    p_count: input.count,
    p_resource_ids: resourceIds,
  });
  if (error) {
    throw mapRpcError(error, "generate_failed", "Could not start generation.");
  }
  if (!isRecord(data) || typeof data.id !== "string") {
    throw new GenerateError(
      "generate_failed",
      "Could not start generation: malformed create_artifact response",
      500,
    );
  }
  return {
    id: data.id,
    kind: input.kind,
    status: "generating",
    href: artifactHref(input.roomId, data.id, input.kind),
  };
}

// ---------------------------------------------------------------------------
// One bounded generation step (POST …/generate/[artifactId]/step)
// ---------------------------------------------------------------------------

export type GenerationStepResult = {
  status: "ready" | "failed";
  id: string;
  question_count: number | null;
  card_count: number | null;
  model: string | null;
  provider: string;
  error_code?: string | null;
  deduped: boolean;
};

/**
 * Advances one artifact with a single provider call. Idempotent when the
 * artifact is already `ready` or `failed` (returns its state, no second
 * spend). Creator-only: a member who did not generate the artifact gets 403.
 * Malformed model output fails the artifact with `ai_provider_failed` and
 * throws — never a `ready` row.
 */
export async function runGenerationStep(
  client: SupabaseClient,
  input: { roomId: string; artifactId: string; userId: string },
): Promise<GenerationStepResult> {
  const artifact = await getArtifact(client, {
    roomId: input.roomId,
    artifactId: input.artifactId,
    viewerId: input.userId,
  });

  // Creator gate first — before any state is revealed — so a non-creator can
  // never learn an artifact's status (generating vs. ready vs. failed, its
  // model, or its error code) by probing the step endpoint.
  if (!artifact.is_creator) {
    throw new GenerateError(
      "not_creator",
      "Only the person who started this generation can run it.",
      403,
    );
  }

  if (artifact.status === "ready") {
    return {
      status: "ready",
      id: artifact.id,
      question_count: artifact.question_count,
      card_count: artifact.card_count,
      model: artifact.model,
      provider: getProvider().name,
      deduped: true,
    };
  }
  if (artifact.status === "failed") {
    return {
      status: "failed",
      id: artifact.id,
      question_count: null,
      card_count: null,
      model: null,
      provider: getProvider().name,
      error_code: artifact.error_code,
      deduped: true,
    };
  }

  const usedToday = await chatTokensUsedToday(client);
  if (usedToday >= CHAT_DAILY_TOKEN_LIMIT) {
    await failArtifact(client, artifact.id, "ai_quota_exceeded");
    throw new GenerateError(
      "ai_quota_exceeded",
      "You have reached your daily AI limit. Try again tomorrow.",
      403,
    );
  }

  const mode: GenerationMode = artifact.kind;
  const count = mode === "quiz" ? artifact.question_count : artifact.card_count;
  if (!count) {
    await failArtifact(client, artifact.id, "ai_provider_failed");
    throw new GenerateError(
      "generate_failed",
      "That artifact has no declared count.",
      500,
    );
  }

  // Broad, authorized retrieval over exactly the selected documents:
  // threshold 0 keeps every ready chunk the caller may read (top-k bounded),
  // so generation is grounded in the real material, not a synthetic query's
  // nearest neighbours alone.
  const titles = await documentTitles(client, artifact.resource_ids);
  const retrieved = await retrieve(client, {
    roomId: artifact.room_id,
    query: buildGenerationQuery(mode, artifact.difficulty, titles),
    topK: 24,
    threshold: 0,
    resourceIds: artifact.resource_ids.length > 0 ? artifact.resource_ids : null,
  });

  if (retrieved.chunks.length === 0) {
    await failArtifact(client, artifact.id, "no_documents_indexed");
    throw new GenerateError(
      "no_documents_indexed",
      "Those documents have no indexed text to generate from.",
      409,
    );
  }

  const budget = applyGenerationContextBudget(retrieved.chunks);
  const questionTypes = artifact.kind === "quiz" ? (["mcq", "tf"] as const) : undefined;
  const messages = buildGenerationMessages(
    {
      mode,
      count,
      difficulty: artifact.difficulty,
      ...(questionTypes ? { questionTypes } : {}),
      titles,
    },
    budget.sources,
  );

  const provider = getProvider();
  let text: string;
  let completionTokens: number;
  let model: string;
  try {
    const completion = await provider.complete({
      messages,
      maxTokens: mode === "quiz"
        ? quizMaxOutputTokens(count)
        : deckMaxOutputTokens(count),
    });
    text = completion.text;
    model = completion.model;
    const promptTokens = estimateTokens(
      messages.map((message) => message.content).join("\n"),
    );
    completionTokens = Math.max(0, completion.tokens - promptTokens);
  } catch (error) {
    await failArtifact(client, artifact.id, "ai_provider_failed");
    throw error;
  }

  // Citations in the payload are 1-based into the *kept* sources; the
  // server stores the citation index itself, so the UI can resolve [n]
  // without trusting the model for titles or links.
  const sourceRefs = toCitationRefs(budget.sources);
  const storedSources = toStoredCitations(sourceRefs);

  let payload: QuizPayloadWithSources | DeckPayloadWithSources;
  try {
    payload = mode === "quiz"
      ? {
          ...parseQuizPayload(text, {
            expectedCount: count,
            sourceCount: budget.sources.length,
          }),
          sources: storedSources,
        }
      : {
          ...parseDeckPayload(text, {
            expectedCount: count,
            sourceCount: budget.sources.length,
          }),
          sources: storedSources,
        };
  } catch (error) {
    await failArtifact(client, artifact.id, "ai_provider_failed");
    if (error instanceof GenerationValidationError) {
      throw new GenerateError(
        "generate_failed",
        `The provider returned malformed study material: ${error.message}`,
        502,
      );
    }
    throw error;
  }

  const { data, error } = await client.rpc("complete_artifact", {
    p_artifact_id: artifact.id,
    p_payload: payload,
    p_model: model,
    p_prompt_tokens: estimateTokens(
      messages.map((message) => message.content).join("\n"),
    ),
    p_completion_tokens: completionTokens,
    p_retrieval_tokens: retrieved.usage.embedTokens,
  });
  if (error) {
    throw mapRpcError(error, "generate_failed", "Could not save the generated material.");
  }
  if (!isRecord(data) || data.status !== "ready") {
    throw new GenerateError(
      "generate_failed",
      "Could not save the generated material: malformed complete_artifact response",
      500,
    );
  }

  // PR-11 retrofit: the artifact owner learns the build finished. Best-effort
  // by contract — a notification failure never fails the generation.
  await notifySelf(client, {
    type: "ai_task_complete",
    userId: input.userId,
    roomId: artifact.room_id,
    payload: {
      title: mode === "quiz" ? "Quiz ready" : "Flashcard deck ready",
      body: mode === "quiz"
        ? `Your ${count}-question quiz is ready to take.`
        : `Your ${count}-card deck is ready to review.`,
    },
    dedupeKey: `ai_task_complete:${artifact.id}`,
  });

  return {
    status: "ready",
    id: artifact.id,
    question_count: typeof data.question_count === "number" ? data.question_count : null,
    card_count: typeof data.card_count === "number" ? data.card_count : null,
    model,
    provider: provider.name,
    deduped: false,
  };
}

/** The retrieval query for generation: mode + difficulty + the real titles. */
export function buildGenerationQuery(
  mode: GenerationMode,
  difficulty: string,
  titles: string[],
): string {
  const subject = titles.length > 0
    ? titles.slice(0, 8).join("; ")
    : "the selected study documents";
  return mode === "quiz"
    ? `Key concepts, definitions, processes and facts from: ${subject}. Revision quiz material, ${difficulty} level.`
    : `Key terms, concepts and definitions from: ${subject}. Flashcard material, ${difficulty} level.`;
}

async function documentTitles(
  client: SupabaseClient,
  resourceIds: string[],
): Promise<string[]> {
  if (resourceIds.length === 0) {
    return [];
  }
  const { data, error } = await client
    .from("study_resources")
    .select("id, title")
    .in("id", resourceIds);
  if (error || !Array.isArray(data)) {
    return [];
  }
  return data.map((row) => String(row.title));
}

function toCitationRefs(
  sources: { citation: { resourceId: string; title: string; href: string; page?: number } }[],
): CitationRef[] {
  return sources.map((source) => ({
    resourceId: source.citation.resourceId,
    title: source.citation.title,
    href: source.citation.href,
    ...(source.citation.page !== undefined
      ? { pages: [source.citation.page] }
      : {}),
  }));
}

export async function failArtifact(
  client: SupabaseClient,
  artifactId: string,
  errorCode: "no_documents_indexed" | "ai_provider_failed" | "ai_quota_exceeded",
): Promise<void> {
  const { error } = await client.rpc("fail_artifact", {
    p_artifact_id: artifactId,
    p_error_code: errorCode,
  });
  if (error) {
    // Best-effort: the caller is already failing the request; a failed
    // fail-artifact leaves the row `generating` for a retry or the UI.
    console.error("[ai/generate] fail_artifact failed:", error.message);
  }
}

export async function deleteArtifact(
  client: SupabaseClient,
  artifactId: string,
): Promise<void> {
  const { error } = await client.rpc("delete_artifact", {
    p_artifact_id: artifactId,
  });
  if (error) {
    throw mapRpcError(error, "artifacts_failed", "Could not delete that item.");
  }
}

// ---------------------------------------------------------------------------
// Quiz attempts
// ---------------------------------------------------------------------------

export type AttemptResultItem = {
  ordinal: number;
  chosen: number | null;
  correct_index: number;
  explanation: string;
  citations: { n: number; page?: number }[];
};

export type Attempt = {
  id: string;
  score: number;
  total: number;
  correct: boolean[];
  results: AttemptResultItem[];
  duration_ms: number | null;
  created_at: string;
};

/**
 * Records one attempt. Scoring happens inside `record_attempt` against the
 * stored answer key; the submitted answers are the only client input, and a
 * score field in the body would be ignored (the schema does not even allow
 * one). Unlimited retakes: every submit is its own immutable row.
 */
export async function recordQuizAttempt(
  client: SupabaseClient,
  input: {
    roomId: string;
    artifactId: string;
    answers: number[];
    durationMs: number | undefined;
  },
): Promise<Attempt> {
  const { data, error } = await client.rpc("record_attempt", {
    p_artifact_id: input.artifactId,
    p_answers: input.answers,
    p_duration_ms: input.durationMs ?? null,
  });
  if (error) {
    throw mapRpcError(error, "attempts_failed", "Could not record that attempt.");
  }
  if (!isRecord(data) || typeof data.id !== "string") {
    throw new GenerateError(
      "attempts_failed",
      "Could not record that attempt: malformed record_attempt response",
      500,
    );
  }
  return {
    id: data.id,
    score: typeof data.score === "number" ? data.score : 0,
    total: typeof data.total === "number" ? data.total : 0,
    correct: Array.isArray(data.correct) ? data.correct.map(Boolean) : [],
    results: Array.isArray(data.results)
      ? (data.results as AttemptResultItem[])
      : [],
    duration_ms: typeof data.duration_ms === "number" ? data.duration_ms : null,
    created_at: String(data.created_at ?? new Date().toISOString()),
  };
}

/** The caller's own attempts on one artifact, newest first (RLS own-row). */
export async function listQuizAttempts(
  client: SupabaseClient,
  input: { artifactId: string },
): Promise<Attempt[]> {
  const { data, error } = await client
    .from("quiz_attempts")
    .select("id, score, total, correct, duration_ms, created_at")
    .eq("artifact_id", input.artifactId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    throw new GenerateError(
      "attempts_failed",
      `attempt list failed: ${error.message}`,
      500,
    );
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map((row) => ({
    id: String(row.id),
    score: typeof row.score === "number" ? row.score : 0,
    total: typeof row.total === "number" ? row.total : 0,
    correct: Array.isArray(row.correct) ? row.correct.map(Boolean) : [],
    results: [],
    duration_ms: typeof row.duration_ms === "number" ? row.duration_ms : null,
    created_at: String(row.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Flashcard reviews
// ---------------------------------------------------------------------------

export type ReviewResult = {
  next_review_at: string;
  interval_days: number;
  streak: number;
  due_count: number;
};

export async function reviewFlashcard(
  client: SupabaseClient,
  input: {
    artifactId: string;
    cardOrdinal: number;
    grade: FlashcardGrade;
  },
): Promise<ReviewResult> {
  const { data, error } = await client.rpc("review_card", {
    p_artifact_id: input.artifactId,
    p_card_ordinal: input.cardOrdinal,
    p_grade: input.grade,
  });
  if (error) {
    throw mapRpcError(error, "review_failed", "Could not save that grade.");
  }
  if (!isRecord(data)) {
    throw new GenerateError(
      "review_failed",
      "Could not save that grade: malformed review_card response",
      500,
    );
  }
  return {
    next_review_at: String(data.next_review_at ?? new Date().toISOString()),
    interval_days: typeof data.interval_days === "number" ? data.interval_days : 0,
    streak: typeof data.streak === "number" ? data.streak : 0,
    due_count: typeof data.due_count === "number" ? data.due_count : 0,
  };
}

export type DeckCardState = {
  ordinal: number;
  front: string;
  back: string;
  citations: { n: number; page?: number }[];
  grade: FlashcardGrade | null;
  streak: number;
  next_review_at: string | null;
  due: boolean;
};

export type DueCardsResult = {
  cards: DeckCardState[];
  due_count: number;
};

/**
 * The caller's own review state for every card in a deck, plus how many are
 * due right now (never reviewed, or `next_review_at` in the past). Cards are
 * returned in ordinal order so the UI can show a stable session.
 */
export async function listDueCards(
  client: SupabaseClient,
  input: { roomId: string; artifactId: string; viewerId: string },
): Promise<DueCardsResult> {
  const artifact = await getArtifact(client, {
    roomId: input.roomId,
    artifactId: input.artifactId,
    viewerId: input.viewerId,
  });
  if (artifact.kind !== "deck" || !artifact.payload || artifact.status !== "ready") {
    throw new GenerateError(
      "artifact_not_ready",
      "That deck is not ready to review.",
      409,
    );
  }

  const { data, error } = await client
    .from("flashcard_reviews")
    .select("card_ordinal, grade, streak, next_review_at")
    .eq("artifact_id", input.artifactId)
    .order("card_ordinal", { ascending: true });
  if (error) {
    throw new GenerateError(
      "review_failed",
      `review state read failed: ${error.message}`,
      500,
    );
  }

  const reviews = new Map<number, { grade: FlashcardGrade; streak: number; next: string }>();
  for (const row of Array.isArray(data) ? data : []) {
    reviews.set(Number(row.card_ordinal), {
      grade: row.grade === "got_it" ? "got_it" : "again",
      streak: typeof row.streak === "number" ? row.streak : 0,
      next: String(row.next_review_at),
    });
  }

  const now = Date.now();
  const cards: DeckCardState[] = (artifact.payload as DeckPayloadWithSources).cards.map(
    (card, ordinal) => {
      const review = reviews.get(ordinal);
      const due = !review || new Date(review.next).getTime() <= now;
      return {
        ordinal,
        front: card.front,
        back: card.back,
        citations: card.citations,
        grade: review?.grade ?? null,
        streak: review?.streak ?? 0,
        next_review_at: review?.next ?? null,
        due,
      };
    },
  );

  return {
    cards,
    due_count: cards.filter((card) => card.due).length,
  };
}
