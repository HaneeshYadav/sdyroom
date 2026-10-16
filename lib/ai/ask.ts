/**
 * "Ask my notes" orchestration (PR-13, spec: docs/prs/PR-13-ask-my-notes.md).
 *
 * The route owns request concerns (session, room id, body validation, rate
 * limit) and this module owns the application pipeline: indexed-documents
 * gate, duplicate replay, chat-quota pre-check, retrieval, completion,
 * answer finalization, and the `record_qa` write that is the table's only
 * insert path. Streaming is a thin envelope over this generator — the
 * provider seam is one-shot today, so a "stream" is citations → one delta →
 * done, with the client contract already shaped for future real streams.
 *
 * Invariants (unit- and integration-tested):
 *   * a question can only reach documents RLS already lets the caller read —
 *     the optional resource filter narrows, never widens, that set;
 *   * citations are exactly the retrieval pipeline's citations; nothing is
 *     invented, and the stored answer carries only in-range `[n]` markers;
 *   * every failure before the first event is an HTTP-mapped `AskError`
 *     (409 no_documents_indexed, 403 ai_quota_exceeded, 502 upstream);
 *   * the chat ledger is written by `record_qa` in the database, which also
 *     re-checks the per-user daily cap — a bypassed route cannot overspend.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { encodeCursor } from "@/lib/notifications/validation";

import { finalizeAnswer } from "./answer";
import { getProvider } from "./provider";
import {
  applyContextBudget,
  ASK_MAX_OUTPUT_TOKENS,
  buildAskMessages,
} from "./prompts/ask";
import { retrieve, type CitationRef } from "./retrieve";
import { estimateTokens } from "./tokens";

/**
 * Per-user chat-token ceiling per UTC day. Mirrors `v_chat_daily_limit` in
 * migration 0018's `record_qa` — the database is the enforcement point; this
 * constant only powers the route's earlier 403 so a spent quota fails before
 * any provider call.
 */
export const CHAT_DAILY_TOKEN_LIMIT = 100_000;

/** The honest low-similarity refusal — never a hallucinated answer. */
export const REFUSAL_ANSWER = "I could not find that in your documents.";

/** Ask failures that map to an HTTP status in the route. */
export type AskErrorCode =
  | "no_documents_indexed"
  | "ai_quota_exceeded"
  | "conversation_history_failed"
  | "documents_failed"
  | "record_failed";

export class AskError extends Error {
  readonly code: AskErrorCode;
  readonly status: number;

  constructor(code: AskErrorCode, message: string, status: number) {
    super(message);
    this.name = "AskError";
    this.code = code;
    this.status = status;
  }
}

/** The stored / streamed citation shape (snake_case matches the jsonb row). */
export type StoredCitation = {
  n: number;
  resource_id: string;
  title: string;
  href: string;
  pages?: number[];
};

/** Usage recorded with the answer; `chat_used_today` feeds quota surfacing. */
export type AskUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  retrieval_tokens: number;
  retrieved_chunks: number;
  chat_used_today: number;
  chat_limit: number;
};

export type AskStreamEvent =
  | { type: "citations"; citations: StoredCitation[] }
  | { type: "delta"; text: string }
  | {
      type: "done";
      qa_id: string;
      conversation_id: string;
      usage: AskUsage;
    };

export type AskInput = {
  roomId: string;
  userId: string;
  question: string;
  /** Already validated uuids; undefined means "every indexed room document". */
  resourceIds?: string[] | undefined;
  /** Client-generated uuid; the route always supplies one. */
  conversationId: string;
};

/** Converts retrieval citations to the stored/streamed shape, 1-based. */
export function toStoredCitations(citations: CitationRef[]): StoredCitation[] {
  return citations.map((citation, index) => ({
    n: index + 1,
    resource_id: citation.resourceId,
    title: citation.title,
    href: citation.href,
    ...(citation.pages ? { pages: [...citation.pages] } : {}),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Defensive read of the jsonb citations column. */
export function parseStoredCitations(value: unknown): StoredCitation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: StoredCitation[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.n !== "number" ||
      typeof entry.resource_id !== "string" ||
      typeof entry.title !== "string" ||
      typeof entry.href !== "string"
    ) {
      continue;
    }
    const pages = Array.isArray(entry.pages)
      ? entry.pages.filter((page): page is number => typeof page === "number")
      : [];
    out.push({
      n: entry.n,
      resource_id: entry.resource_id,
      title: entry.title,
      href: entry.href,
      ...(pages.length > 0 ? { pages } : {}),
    });
  }
  return out;
}

/**
 * How many indexed (`ready`) documents the caller can ask about in this
 * room. The count goes through `study_resources` because that is where
 * `room_id` lives — RLS on the resource row decides visibility, and the
 * embedded `study_ai_documents.status` decides readiness. A narrow
 * `resourceIds` list is honoured so the 409 reflects what the caller
 * actually selected.
 */
export async function countReadyDocuments(
  client: SupabaseClient,
  roomId: string,
  resourceIds?: string[],
): Promise<number> {
  const { data, error } = await client
    .from("study_resources")
    .select("id, study_ai_documents(status)")
    .eq("room_id", roomId);
  if (error) {
    throw new AskError(
      "documents_failed",
      `document status check failed: ${error.message}`,
      500,
    );
  }
  if (!Array.isArray(data)) {
    return 0;
  }
  const allowed = resourceIds && resourceIds.length > 0
    ? new Set(resourceIds)
    : null;
  let ready = 0;
  for (const row of data) {
    if (allowed && !allowed.has(String(row.id))) {
      continue;
    }
    const ai = isRecord(row.study_ai_documents) ? row.study_ai_documents : null;
    const aiRow = Array.isArray(ai)
      ? (ai[0] as Record<string, unknown> | undefined)
      : ai;
    if (aiRow?.status === "ready") {
      ready += 1;
    }
  }
  return ready;
}

/** The caller's own chat-token spend so far today (invoker rights, own rows). */
export async function chatTokensUsedToday(
  client: SupabaseClient,
): Promise<number> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { data, error } = await client
    .from("ai_usage")
    .select("amount")
    .eq("kind", "chat_tokens")
    .gte("created_at", dayStart.toISOString());
  if (error) {
    throw new AskError(
      "conversation_history_failed",
      `chat usage check failed: ${error.message}`,
      500,
    );
  }
  if (!Array.isArray(data)) {
    return 0;
  }
  return data.reduce(
    (total, row) =>
      total + (typeof row.amount === "number" ? row.amount : 0),
    0,
  );
}

export type RecentDuplicate = {
  qaId: string;
  conversationId: string;
  answer: string;
  citations: StoredCitation[];
};

/**
 * A same-question row from the last 60 seconds in the same conversation —
 * the double-submit replay. Reads only the caller's own rows (RLS +
 * column-scoped SELECT).
 */
export async function findRecentDuplicate(
  client: SupabaseClient,
  input: {
    roomId: string;
    conversationId: string;
    question: string;
  },
): Promise<RecentDuplicate | null> {
  const windowStart = new Date(Date.now() - 60_000).toISOString();
  const { data, error } = await client
    .from("study_qa")
    .select("id, conversation_id, answer, citations")
    .eq("room_id", input.roomId)
    .eq("conversation_id", input.conversationId)
    .eq("question", input.question)
    .gt("created_at", windowStart)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    throw new AskError(
      "record_failed",
      `duplicate check failed: ${error.message}`,
      500,
    );
  }
  const row = Array.isArray(data) ? data[0] : undefined;
  if (!row || typeof row.id !== "string") {
    return null;
  }
  return {
    qaId: row.id,
    conversationId:
      typeof row.conversation_id === "string"
        ? row.conversation_id
        : input.conversationId,
    answer: typeof row.answer === "string" ? row.answer : "",
    citations: parseStoredCitations(row.citations),
  };
}

type RecordQaResult = {
  qaId: string;
  chatUsedToday: number;
  chatLimit: number;
};

async function recordQa(
  client: SupabaseClient,
  input: {
    roomId: string;
    conversationId: string;
    question: string;
    answer: string;
    citations: StoredCitation[];
    model: string | null;
    promptTokens: number;
    completionTokens: number;
    retrievalTokens: number;
    retrievedChunks: number;
  },
): Promise<RecordQaResult> {
  const { data, error } = await client.rpc("record_qa", {
    p_room_id: input.roomId,
    p_conversation_id: input.conversationId,
    p_question: input.question,
    p_answer: input.answer,
    p_citations: input.citations,
    p_model: input.model,
    p_prompt_tokens: input.promptTokens,
    p_completion_tokens: input.completionTokens,
    p_retrieval_tokens: input.retrievalTokens,
    p_retrieved_chunks: input.retrievedChunks,
  });
  if (error) {
    if (error.message.includes("ai_quota_exceeded")) {
      throw new AskError(
        "ai_quota_exceeded",
        "You have reached your daily AI limit. Try again tomorrow.",
        403,
      );
    }
    if (error.message.includes("not_found")) {
      throw new AskError(
        "no_documents_indexed",
        "That room does not exist or is not available.",
        404,
      );
    }
    throw new AskError(
      "record_failed",
      `recording the answer failed: ${error.message}`,
      500,
    );
  }
  if (!isRecord(data) || typeof data.qa_id !== "string") {
    throw new AskError(
      "record_failed",
      "recording the answer failed: malformed record_qa response",
      500,
    );
  }
  return {
    qaId: data.qa_id,
    chatUsedToday:
      typeof data.chat_used_today === "number" ? data.chat_used_today : 0,
    chatLimit: typeof data.chat_limit === "number"
      ? data.chat_limit
      : CHAT_DAILY_TOKEN_LIMIT,
  };
}

/**
 * One full ask pass. Emits at most three events (citations, delta, done);
 * every failure throws `AskError` or the provider/retrieval error before the
 * first event, so the route can answer with a plain JSON status.
 */
export async function* runAsk(
  client: SupabaseClient,
  input: AskInput,
): AsyncGenerator<AskStreamEvent, void, undefined> {
  const ready = await countReadyDocuments(
    client,
    input.roomId,
    input.resourceIds,
  );
  if (ready === 0) {
    throw new AskError(
      "no_documents_indexed",
      "Index at least one document before asking a question.",
      409,
    );
  }

  const duplicate = await findRecentDuplicate(client, {
    roomId: input.roomId,
    conversationId: input.conversationId,
    question: input.question,
  });
  if (duplicate) {
    yield { type: "citations", citations: duplicate.citations };
    yield { type: "delta", text: duplicate.answer };
    yield {
      type: "done",
      qa_id: duplicate.qaId,
      conversation_id: duplicate.conversationId,
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        retrieval_tokens: 0,
        retrieved_chunks: duplicate.citations.length,
        chat_used_today: 0,
        chat_limit: CHAT_DAILY_TOKEN_LIMIT,
      },
    };
    return;
  }

  const usedToday = await chatTokensUsedToday(client);
  if (usedToday >= CHAT_DAILY_TOKEN_LIMIT) {
    throw new AskError(
      "ai_quota_exceeded",
      "You have reached your daily AI limit. Try again tomorrow.",
      403,
    );
  }

  // RetrieveError and AiProviderError propagate untouched: the route maps
  // them to 502. No mock fallback when a real provider is configured.
  const retrieved = await retrieve(client, {
    roomId: input.roomId,
    query: input.question,
    resourceIds: input.resourceIds ?? null,
  });

  let answer: string;
  let storedCitations: StoredCitation[];
  let promptTokens = 0;
  let completionTokens = 0;
  let model: string | null = null;

  if (retrieved.chunks.length === 0) {
    // Low-similarity / no-chunks refusal: no completion call, nothing
    // invented; the row still records retrieval spend and zero chunks.
    answer = REFUSAL_ANSWER;
    storedCitations = [];
  } else {
    const budget = applyContextBudget(retrieved.chunks);
    const messages = buildAskMessages(input.question, budget.sources);
    const provider = getProvider();
    const completion = await provider.complete({
      messages,
      maxTokens: ASK_MAX_OUTPUT_TOKENS,
    });
    promptTokens = estimateTokens(
      messages.map((message) => message.content).join("\n"),
    );
    completionTokens = Math.max(0, completion.tokens - promptTokens);
    model = completion.model;
    // [n] markers must match the *kept* sources, which renumber 1..k after
    // budgeting — so both the answer layer and the stored citations get the
    // kept set rebuilt in keep-order, not the raw retrieval order.
    const kept = toCitationRefs(budget.sources);
    answer = finalizeAnswer(completion.text, kept);
    storedCitations = toStoredCitations(kept);
  }

  const recorded = await recordQa(client, {
    roomId: input.roomId,
    conversationId: input.conversationId,
    question: input.question,
    answer,
    citations: storedCitations,
    model,
    promptTokens,
    completionTokens,
    retrievalTokens: retrieved.usage.embedTokens,
    retrievedChunks: retrieved.chunks.length,
  });

  yield { type: "citations", citations: storedCitations };
  yield { type: "delta", text: answer };
  yield {
    type: "done",
    qa_id: recorded.qaId,
    conversation_id: input.conversationId,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      retrieval_tokens: retrieved.usage.embedTokens,
      retrieved_chunks: retrieved.chunks.length,
      chat_used_today: recorded.chatUsedToday,
      chat_limit: recorded.chatLimit,
    },
  };
}

/** Rebuilds CitationRef[] from the kept sources in keep-order. */
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

// ---------------------------------------------------------------------------
// History + document selector reads (the two GET routes)
// ---------------------------------------------------------------------------

export type AskHistoryItem = {
  id: string;
  question: string;
  answer: string;
  citations: StoredCitation[];
  conversation_id: string;
  created_at: string;
};

export type AskHistoryPage = {
  items: AskHistoryItem[];
  next_cursor: string | null;
};

/**
 * The caller's own Q/A rows for one room, newest first, keyset-paginated
 * with the shared opaque-cursor helper. Column-scoped SELECT (0018) means
 * token accounting never leaves the database even if this query asked.
 */
export async function listAskHistory(
  client: SupabaseClient,
  input: {
    roomId: string;
    limit: number;
    cursor: { createdAt: string; id: string } | undefined;
  },
): Promise<AskHistoryPage> {
  let query = client
    .from("study_qa")
    .select("id, question, answer, citations, conversation_id, created_at")
    .eq("room_id", input.roomId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(input.limit + 1);

  if (input.cursor) {
    query = query.or(
      `created_at.lt."${input.cursor.createdAt}",and(created_at.eq."${input.cursor.createdAt}",id.lt."${input.cursor.id}")`,
    );
  }

  const { data, error } = await query;
  if (error) {
    throw new AskError(
      "conversation_history_failed",
      `history read failed: ${error.message}`,
      500,
    );
  }

  const rows = Array.isArray(data) ? data : [];
  const page = rows.slice(0, input.limit);
  const items: AskHistoryItem[] = page.map((row) => ({
    id: String(row.id),
    question: String(row.question),
    answer: String(row.answer),
    citations: parseStoredCitations(row.citations),
    conversation_id: String(row.conversation_id),
    created_at: String(row.created_at),
  }));
  const last = page.length === input.limit ? page[page.length - 1] : undefined;
  return {
    items,
    next_cursor:
      rows.length > input.limit && last
        ? encodeCursor(String(last.created_at), String(last.id))
        : null,
  };
}

export type AskDocument = {
  resource_id: string;
  title: string;
  status: string;
  chunks: number;
};

/**
 * Room documents visible to the caller (RLS), for the scope selector. Status
 * rides along so the UI can show processing/failed files as disabled options
 * rather than hiding them — hiding would make "why can't I ask about my
 * file?" unanswerable.
 */
export async function listAskDocuments(
  client: SupabaseClient,
  roomId: string,
): Promise<AskDocument[]> {
  const { data, error } = await client
    .from("study_resources")
    .select("id, title, study_ai_documents(status, chunk_count)")
    .eq("room_id", roomId)
    .order("title", { ascending: true });
  if (error) {
    throw new AskError(
      "documents_failed",
      `document list failed: ${error.message}`,
      500,
    );
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map((row) => {
    const ai = isRecord(row.study_ai_documents) ? row.study_ai_documents : null;
    // The embed is a to-one; PostgREST may return object or single-element
    // array depending on shape — handle both without failing the list.
    const aiRow = Array.isArray(ai)
      ? (ai[0] as Record<string, unknown> | undefined)
      : ai;
    return {
      resource_id: String(row.id),
      title: String(row.title),
      status: typeof aiRow?.status === "string" ? aiRow.status : "pending",
      chunks: typeof aiRow?.chunk_count === "number" ? aiRow.chunk_count : 0,
    };
  });
}
