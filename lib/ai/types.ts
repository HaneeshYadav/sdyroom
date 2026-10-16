/**
 * Shared AI vocabulary — the wire contract between the database (migration
 * 0013), the ingest pipeline, the routes, and the status UI.
 *
 * Every union here mirrors a CHECK constraint or an RPC parameter list in
 * `supabase/migrations/0013_ai_documents.sql`; changing a value means changing
 * both, and the integration suite asserts the pairs stay aligned.
 */

/**
 * Embedding width, fixed at 1536 for `text-embedding-3-small`-class models
 * (the migration's `vector(1536)` column and every RPC signature). A different
 * model needs a new migration and a full re-embed — never a silent widening.
 */
export const AI_EMBEDDING_DIMENSIONS = 1536;

/**
 * Content types the ingestion pipeline can turn into text. Deliberately wider
 * than `RESOURCE_CONTENT_TYPES`: extraction also supports CSV and DOCX so a
 * row created by a future upload change (or by a test fixture) can be indexed
 * without another migration. Everything else — images above all — answers
 * `unsupported_media_type`.
 */
export const INDEXABLE_CONTENT_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export type IndexableContentType = (typeof INDEXABLE_CONTENT_TYPES)[number];

export function isIndexableContentType(value: string): value is IndexableContentType {
  return (INDEXABLE_CONTENT_TYPES as readonly string[]).includes(value);
}

/** Stored status values — the `study_ai_documents.status` CHECK list. */
export const INGEST_STATUSES = [
  "pending",
  "extracting",
  "chunking",
  "embedding",
  "ready",
  "failed",
] as const;

export type IngestStatus = (typeof INGEST_STATUSES)[number];

/** The steps `POST /api/ai/ingest/[resourceId]` accepts; `auto` advances one. */
export const INGEST_STEPS = ["extract", "chunk", "embed", "auto"] as const;

export type IngestStep = (typeof INGEST_STEPS)[number];

/** The `study_ai_documents.error_code` CHECK list — every failure the UI maps. */
export const INGEST_ERROR_CODES = [
  "no_text_layer",
  "extract_failed",
  "extracted_too_large",
  "ingest_failed",
  "ai_quota_exceeded",
  "ai_provider_failed",
] as const;

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

export function isIngestErrorCode(value: unknown): value is IngestErrorCode {
  return (
    typeof value === "string" &&
    (INGEST_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Status exposure on a resource list row: absent row = never started. */
export type AiDocumentStatusInfo = {
  status: IngestStatus;
  error_code: IngestErrorCode | null;
};

/** A chunk before it carries a vector — the output of the chunk step. */
export type ChunkDraft = {
  ordinal: number;
  text: string;
  tokens: number;
  /** 1-based PDF page; null for plain-text formats. */
  page_start: number | null;
  /** Nearest Markdown heading, when the chunk came from a `.md` document. */
  heading: string | null;
};

/** A chunk ready for `ingest_record_chunk` — draft plus provider vector. */
export type EmbeddedChunk = ChunkDraft & {
  embedding: number[];
};

/** Steps an ingest call may report as done (null = nothing ran). */
export type IngestStepDone = "extract" | "chunk" | "embed" | null;
