import { toStudyResource } from "@/lib/resources/shape";
import { STUDY_RESOURCE_COLUMNS } from "@/lib/resources/types";
import { describe, expect, it } from "vitest";

const ROW = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "Rotational motion",
  original_filename: "rotational.pdf",
  content_type: "application/pdf",
  size_bytes: 2048,
  subject: "Physics",
  chapter: "Chapter 4",
  room_id: null,
  created_at: "2026-10-06T07:00:00+00:00",
  updated_at: "2026-10-06T07:00:00+00:00",
  owner_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storage_path: "personal/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/4444.pdf",
};

describe("toStudyResource", () => {
  it("keeps the exposed fields and drops owner_id and storage_path", () => {
    const resource = toStudyResource(ROW);

    expect(resource).toEqual({
      id: ROW.id,
      title: ROW.title,
      original_filename: ROW.original_filename,
      content_type: ROW.content_type,
      size_bytes: ROW.size_bytes,
      subject: ROW.subject,
      chapter: ROW.chapter,
      room_id: null,
      created_at: ROW.created_at,
      updated_at: ROW.updated_at,
      ai: null,
      is_owner: false,
    });
    expect(Object.keys(resource)).not.toContain("owner_id");
    expect(Object.keys(resource)).not.toContain("storage_path");
  });

  it("parses the study_ai_documents embed onto ai", () => {
    const resource = toStudyResource({
      ...ROW,
      study_ai_documents: { status: "embedding", error_code: "ai_provider_failed" },
    });

    expect(resource.ai).toEqual({
      status: "embedding",
      error_code: "ai_provider_failed",
    });

    expect(toStudyResource({ ...ROW, study_ai_documents: null }).ai).toBeNull();
  });

  it.each([
    "unknown_status",
    { status: "ready", error_code: "not_a_code" },
    { status: 42 },
    "not-an-object",
  ])("degrades a malformed ai embed to null: %j", (embed) => {
    expect(toStudyResource({ ...ROW, study_ai_documents: embed }).ai).toBeNull();
  });

  it("reads is_owner strictly as a viewer signal", () => {
    expect(toStudyResource({ ...ROW, is_owner: true }).is_owner).toBe(true);
    expect(toStudyResource({ ...ROW, is_owner: "yes" }).is_owner).toBe(false);
    expect(toStudyResource(ROW).is_owner).toBe(false);
  });

  it("normalises absent optional text to null", () => {
    const resource = toStudyResource({ ...ROW, subject: null, chapter: null });

    expect(resource.subject).toBeNull();
    expect(resource.chapter).toBeNull();
  });

  it.each([
    ["id", 42],
    ["title", 42],
    ["content_type", "application/zip"],
    ["size_bytes", "big"],
    ["size_bytes", -1],
    ["room_id", 42],
    ["created_at", null],
  ])("rejects a row where %s is %j", (field, value) => {
    expect(() => toStudyResource({ ...ROW, [field]: value })).toThrow();
  });

  it("rejects a payload that is not an object", () => {
    expect(() => toStudyResource(null)).toThrow("Missing resource payload.");
    expect(() => toStudyResource([ROW])).toThrow("Missing resource payload.");
  });
});

describe("STUDY_RESOURCE_COLUMNS", () => {
  it("never selects the whole table", () => {
    expect(STUDY_RESOURCE_COLUMNS).not.toContain("*");
    expect(STUDY_RESOURCE_COLUMNS).not.toContain("owner_id");
    expect(STUDY_RESOURCE_COLUMNS).not.toContain("storage_path");
  });
});
