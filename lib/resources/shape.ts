import {
  isIngestErrorCode,
  INGEST_STATUSES,
  type AiDocumentStatusInfo,
} from "@/lib/ai/types";
import { RESOURCE_CONTENT_TYPES, type StudyResource } from "./types";

function envelopeOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Unexpected resource payload: ${field} is not a string.`);
  }
  return value;
}

/**
 * The `study_ai_documents(status, error_code)` embed — read defensively:
 * `null` means "never indexed", and *any* shape we cannot recognise degrades
 * to `null` rather than failing the whole list (same posture as
 * `toNotificationView`): a status chip must never take down a page.
 */
function aiStatusOf(row: Record<string, unknown>): AiDocumentStatusInfo | null {
  const raw = row.study_ai_documents;
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const status = (raw as Record<string, unknown>).status;
  const errorCode = (raw as Record<string, unknown>).error_code;
  if (!(INGEST_STATUSES as readonly unknown[]).includes(status)) {
    return null;
  }
  if (errorCode !== null && !isIngestErrorCode(errorCode)) {
    return null;
  }
  return {
    status: status as AiDocumentStatusInfo["status"],
    error_code: errorCode as AiDocumentStatusInfo["error_code"],
  };
}

/**
 * Parses a raw `study_resources` row onto the exposed view shape, or throws on
 * malformed data.
 *
 * Every producer — a list page, the upload confirmation, a download
 * resolution — runs through here, so a column that is later added to the table
 * cannot reach a client by accident: only the listed fields survive, and
 * `owner_id` / `storage_path` are never read.
 */
export function toStudyResource(value: unknown): StudyResource {
  const row = envelopeOf(value);
  if (!row) {
    throw new Error("Missing resource payload.");
  }

  const id = row.id;
  const title = row.title;
  const originalFilename = row.original_filename;
  const contentType = row.content_type;
  const sizeBytes = row.size_bytes;
  const roomId = row.room_id;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;

  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof originalFilename !== "string" ||
    typeof contentType !== "string" ||
    !(RESOURCE_CONTENT_TYPES as readonly string[]).includes(contentType) ||
    typeof sizeBytes !== "number" ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes < 0 ||
    (roomId !== null && typeof roomId !== "string") ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw new Error(
      `Unexpected resource payload: ${JSON.stringify(value).slice(0, 200)}`,
    );
  }

  return {
    id,
    title,
    original_filename: originalFilename,
    content_type: contentType as StudyResource["content_type"],
    size_bytes: sizeBytes,
    subject: optionalText(row.subject, "subject"),
    chapter: optionalText(row.chapter, "chapter"),
    room_id: roomId,
    created_at: createdAt,
    updated_at: updatedAt,
    ai: aiStatusOf(row),
    // Absent → false (hides owner-only controls); a non-boolean also reads
    // false: the fail-safe direction is "no owner powers", never "all of them".
    is_owner: row.is_owner === true,
  };
}
