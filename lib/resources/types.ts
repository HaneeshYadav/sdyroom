import type { AiDocumentStatusInfo } from "@/lib/ai/types";

/**
 * Content types this milestone accepts. The list is closed: anything else is
 * rejected before it reaches storage.
 */
export const RESOURCE_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/plain",
  "text/markdown",
] as const;

export type ResourceContentType = (typeof RESOURCE_CONTENT_TYPES)[number];

/**
 * File extensions accepted for upload, mapped to the content type the server
 * assigns. The extension selects the *candidate*; the signature check confirms
 * it, and a mismatch is rejected rather than trusted.
 */
export const RESOURCE_EXTENSIONS: Record<string, ResourceContentType> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
};

/**
 * A resource as every API and page response exposes it.
 *
 * Deliberately absent: `owner_id` (the audience of a row is either "you" or
 * "everyone in this room", so an owner id only widens the payload),
 * `storage_path` (an internal locator that would let a caller attempt path
 * guessing), and the bucket name.
 */
export type StudyResource = {
  id: string;
  title: string;
  original_filename: string;
  content_type: ResourceContentType;
  size_bytes: number;
  subject: string | null;
  chapter: string | null;
  room_id: string | null;
  created_at: string;
  updated_at: string;
  /**
   * AI index state (PR 12). `null` = no `study_ai_documents` row exists yet
   * ("Not indexed"); the status/error_code pair drives the chip and the
   * owner-only "Index now" retry. Derived from a read-time embed — never
   * stored on the resource row.
   */
  ai: AiDocumentStatusInfo | null;
  /**
   * Whether the *viewer* owns this file. `owner_id` itself stays unreadable
   * (no SELECT grant — 0005); this boolean comes from the
   * `resource_owner_ids` RPC and is what gates owner-only actions in the UI.
   */
  is_owner: boolean;
};

/** Explicit column list — never `SELECT *`, matching `STUDY_GOAL_COLUMNS`. */
export const STUDY_RESOURCE_COLUMNS =
  "id, title, original_filename, content_type, size_bytes, subject, chapter, room_id, created_at, updated_at";

/** Private bucket holding every study resource. Never public. */
export const RESOURCE_BUCKET = "study-resources";

/** Total ordering for a page of resources: newest first, ties broken by id. */
export const RESOURCE_ORDER = { column: "created_at", ascending: false } as const;
