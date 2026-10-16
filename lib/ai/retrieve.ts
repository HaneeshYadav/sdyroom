/**
 * RAG retrieval — the single entry point PRs 13–16 build on.
 *
 * One flow: embed the query with the configured provider → `match_document_chunks`
 * (the only table function that may read `document_chunks.embedding`; it
 * re-checks room membership / personal ownership and only returns `ready`
 * documents) → a light rerank pass (score threshold + top-k window) →
 * citation assembly.
 *
 * Contracts kept here (unit-tested):
 *   * `citation.href` always names a route that exists today — personal
 *     files land on `/resources`, room files on `/rooms/{roomId}`; no viewer
 *     is invented (PR-13's guidance: link what exists);
 *   * citations are de-duplicated per resource in best-first order, each
 *     chunk carries its own `citation.n` so a prompt assembler can number
 *     sources without rebuilding the map;
 *   * retrieved text is data, never instructions — callers must keep it in
 *     the user/app part of a prompt, never in the system prompt (see
 *     docs/SECURITY.md);
 *   * nothing here writes the usage ledger — embed spend is recorded by the
 *     ingest RPCs, and ask/quiz flows record their own (PR-13+).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getProvider } from "./provider";

/** Defaults mirroring `match_document_chunks` (migration 0013). */
export const RETRIEVAL_DEFAULT_TOP_K = 8;
export const RETRIEVAL_DEFAULT_THRESHOLD = 0.2;
export const RETRIEVAL_MAX_TOP_K = 50;

/** Unrecoverable retrieval failures (RPC outage) — mapped by callers. */
export class RetrieveError extends Error {
  readonly code = "retrieval_failed";

  constructor(message: string) {
    super(message);
    this.name = "RetrieveError";
  }
}

export type CitationRef = {
  resourceId: string;
  title: string;
  href: string;
  /** Distinct pages this resource contributed, in appearance order. */
  pages?: number[];
};

export type ChunkCitation = {
  /** 1-based position in `citations` — the `[n]` a prompt should use. */
  n: number;
  resourceId: string;
  title: string;
  href: string;
  page?: number;
};

export type RetrievedChunk = {
  resourceId: string;
  chunkId: string;
  text: string;
  score: number;
  page?: number;
  heading?: string | null;
  citation: ChunkCitation;
};

export type RetrievalResult = {
  chunks: RetrievedChunk[];
  citations: CitationRef[];
};

export type RetrieveInput = {
  /** Room scope; null = the caller's personal documents only (RPC-enforced). */
  roomId: string | null;
  query: string;
  topK?: number;
  threshold?: number;
};

/**
 * Deep link per scope — a route that exists *now*. Same philosophy as
 * `hrefForNotification`: derive at assembly time, never persist, so a route
 * rename is a one-line change here and the href unit test catches misses.
 */
export function hrefForResource(roomId: string | null): string {
  return roomId === null ? "/resources" : `/rooms/${roomId}`;
}

function clampTopK(value: number | undefined): number {
  const topK = value ?? RETRIEVAL_DEFAULT_TOP_K;
  if (!Number.isFinite(topK)) {
    return RETRIEVAL_DEFAULT_TOP_K;
  }
  return Math.max(1, Math.min(RETRIEVAL_MAX_TOP_K, Math.floor(topK)));
}

function parseRow(row: Record<string, unknown>): {
  resourceId: string;
  chunkId: string;
  ordinal: number;
  text: string;
  title: string;
  roomId: string | null;
  score: number;
  page: number | null;
  heading: string | null;
} | null {
  if (
    typeof row.resource_id !== "string" ||
    typeof row.chunk_id !== "string" ||
    typeof row.text !== "string" ||
    typeof row.title !== "string" ||
    typeof row.score !== "number"
  ) {
    return null;
  }
  return {
    resourceId: row.resource_id,
    chunkId: row.chunk_id,
    ordinal: typeof row.ordinal === "number" ? row.ordinal : 0,
    text: row.text,
    title: row.title,
    roomId: typeof row.room_id === "string" ? row.room_id : null,
    score: row.score,
    page: typeof row.page_start === "number" ? row.page_start : null,
    heading: typeof row.heading === "string" ? row.heading : null,
  };
}

type MatchRow = NonNullable<ReturnType<typeof parseRow>>;

/**
 * Embeds the query and returns the matching chunks plus their citations.
 *
 * Returns `{ chunks: [], citations: [] }` when nothing clears the threshold —
 * an ordinary outcome (a refusal, not an error) that PR-13 turns into its
 * "no relevant passages" path. Provider failures propagate as
 * `AiProviderError` (502 upstream; no mock fallback).
 */
export async function retrieve(
  client: SupabaseClient,
  input: RetrieveInput,
): Promise<RetrievalResult> {
  const topK = clampTopK(input.topK);
  const threshold =
    typeof input.threshold === "number" &&
    Number.isFinite(input.threshold)
      ? input.threshold
      : RETRIEVAL_DEFAULT_THRESHOLD;

  const provider = getProvider();
  const embedded = await provider.embed([input.query]);
  const vector = embedded.vectors[0];
  if (!vector) {
    return { chunks: [], citations: [] };
  }

  const { data, error } = await client.rpc("match_document_chunks", {
    p_room_id: input.roomId,
    p_query_embedding: `[${vector.join(",")}]`,
    p_limit: topK,
    p_threshold: threshold,
  });

  if (error) {
    throw new RetrieveError(`match_document_chunks failed: ${error.message}`);
  }

  const rows: MatchRow[] = [];
  if (Array.isArray(data)) {
    for (const raw of data) {
      if (raw && typeof raw === "object") {
        const parsed = parseRow(raw as Record<string, unknown>);
        if (parsed) {
          rows.push(parsed);
        }
      }
    }
  }

  // The RPC already applied the threshold and top-k window; re-filtering here
  // keeps `retrieve()` honest on its own (unit tests, and any future caller
  // that relaxes an RPC parameter) without changing what the DB returned.
  const kept = rows
    .filter((row) => row.score >= threshold)
    .sort((a, b) => a.score - b.score)
    .reverse()
    .slice(0, topK);

  const citations: CitationRef[] = [];
  const indexByResource = new Map<string, number>();
  const chunks: RetrievedChunk[] = kept.map((row) => {
    let n = indexByResource.get(row.resourceId);
    if (n === undefined) {
      const href = hrefForResource(row.roomId);
      const citation: CitationRef = {
        resourceId: row.resourceId,
        title: row.title,
        href,
        ...(row.page !== null ? { pages: [row.page] } : {}),
      };
      citations.push(citation);
      n = citations.length;
      indexByResource.set(row.resourceId, n);
    } else if (row.page !== null) {
      const pages = citations[n - 1].pages;
      if (pages && !pages.includes(row.page)) {
        pages.push(row.page);
      }
    }

    return {
      resourceId: row.resourceId,
      chunkId: row.chunkId,
      text: row.text,
      score: row.score,
      ...(row.page !== null ? { page: row.page } : {}),
      heading: row.heading,
      citation: {
        n,
        resourceId: row.resourceId,
        title: row.title,
        href: citations[n - 1].href,
        ...(row.page !== null ? { page: row.page } : {}),
      },
    };
  });

  return { chunks, citations };
}
