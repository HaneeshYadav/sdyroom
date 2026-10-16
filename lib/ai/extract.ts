/**
 * Text extraction — the extract step of the ingest pipeline.
 *
 * Supported inputs (spec: exactly these, everything else
 * `unsupported_media_type`):
 *
 *   PDF   — text layer only via `unpdf`; a scanned/image-only PDF yields
 *           `no_text_layer` (OCR is explicitly out of scope, so the UI says
 *           so instead of pretending). Pages are joined with `\f`, the
 *           separator the chunker treats as a hard boundary so page
 *           references survive into citations;
 *   txt/md/csv — decoded as strict UTF-8;
 *   docx  — `word/document.xml` read out of the ZIP container by
 *           `lib/ai/zip.ts`, tags stripped, paragraphs mapped to newlines.
 *
 * Documents are untrusted bytes: extraction never executes anything from the
 * file, never fetches a URL the file mentions, and never logs the content.
 * Size is capped at 16 MiB of *extracted text* (the same ceiling the
 * database enforces) so a tiny, highly compressible PDF cannot park
 * gigabytes in the row.
 */

import { extractText, getDocumentProxy } from "unpdf";
import { readZipEntry } from "./zip";
import type { IngestErrorCode } from "./types";

export type ExtractFailureCode = Extract<
  IngestErrorCode,
  "no_text_layer" | "extract_failed" | "extracted_too_large"
> | "unsupported_media_type";

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; code: ExtractFailureCode };

/** Mirrors the 16 MiB guard inside `ingest_record_extraction`. */
export const MAX_EXTRACTED_BYTES = 16 * 1024 * 1024;

const PDF_CONTENT_TYPE = "application/pdf";
const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXT_CONTENT_TYPES = ["text/plain", "text/markdown", "text/csv"];

const DOCX_MAIN_PART = "word/document.xml";

function failed(code: ExtractFailureCode): ExtractResult {
  return { ok: false, code };
}

function sizeCheck(text: string): ExtractResult {
  if (Buffer.byteLength(text, "utf8") > MAX_EXTRACTED_BYTES) {
    return failed("extracted_too_large");
  }
  return { ok: true, text };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    // Strip a leading BOM: it is an encoding artefact, not document content,
    // and would otherwise land at the head of the first chunk.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractResult> {
  try {
    const pdf = await getDocumentProxy(bytes);
    try {
      const { text: pages } = await extractText(pdf, { mergePages: false });
      const joined = pages.join("\f");
      return sizeCheck(joined);
    } finally {
      // unpdf owns the lifecycle through the loading task (its own
      // `withDocument` releases the same way); release workers and file
      // handles even when text extraction itself threw.
      await pdf.loadingTask.destroy().catch(() => undefined);
    }
  } catch {
    // A corrupt or non-PDF container is an extraction failure, not a crash.
    return failed("extract_failed");
  }
}

/**
 * `word/document.xml` → plain text. Paragraph ends (`</w:p>`) become
 * newlines before tags are stripped, tabs and breaks keep their shape, and
 * entities are decoded with `&amp;` last so `&amp;lt;` cannot become `<`
 * through a double pass.
 */
export function docxXmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:tab[^>]*\/?>/g, "\t")
    .replace(/<w:br[^>]*\/?>/g, "\n")
    .replace(/<w:cr[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "");

  const withEntities = withBreaks
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    })
    .replace(/&#(\d+);/g, (match, decimal: string) => {
      const code = Number.parseInt(decimal, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

  // Collapse runs of blank lines: paragraph-per-line output otherwise keeps
  // the document's own empty-paragraph padding, which only inflates chunks.
  return withEntities.replace(/\n{3,}/g, "\n\n");
}

function extractDocx(bytes: Uint8Array): ExtractResult {
  const part = readZipEntry(bytes, DOCX_MAIN_PART);
  if (part === null) {
    return failed("extract_failed");
  }
  const xml = decodeUtf8(part);
  if (xml === null) {
    return failed("extract_failed");
  }
  return sizeCheck(docxXmlToText(xml));
}

function extractPlainText(bytes: Uint8Array): ExtractResult {
  const text = decodeUtf8(bytes);
  if (text === null) {
    return failed("extract_failed");
  }
  return sizeCheck(text);
}

/**
 * Extracts indexable text for one uploaded document.
 *
 * Empty output is a *success* with empty text on purpose: the database's
 * `ingest_record_extraction` is the single authority that turns an empty
 * document into `failed / no_text_layer`, so the rule exists in exactly one
 * place regardless of which caller noticed it first.
 */
export async function extractDocument(
  bytes: Uint8Array,
  contentType: string,
): Promise<ExtractResult> {
  if (contentType === PDF_CONTENT_TYPE) {
    return extractPdf(bytes);
  }
  if (contentType === DOCX_CONTENT_TYPE) {
    return extractDocx(bytes);
  }
  if ((TEXT_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return extractPlainText(bytes);
  }
  return failed("unsupported_media_type");
}
