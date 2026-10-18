import { GET } from "@/app/api/rooms/[id]/preview/route";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, getRoomPreview } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  getRoomPreview: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/rooms/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/discovery")>()),
  getRoomPreview,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const preview = {
  id: ROOM_ID,
  name: "Alpha Physics",
  shared_goal: "Finish mechanics",
  subject: "Physics",
  exam_track: "JEE",
  language: "English",
  visibility: "public",
  status: "open",
  capacity: 6,
  member_count: 3,
  created_at: "2026-09-20T00:00:00.000Z",
  is_member: false,
  viewer_role: null,
};

function getRequest() {
  return new NextRequest(`http://localhost:3000/api/rooms/${ROOM_ID}/preview`);
}

const context = { params: Promise.resolve({ id: ROOM_ID }) };

describe("GET /api/rooms/[id]/preview", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    getRoomPreview.mockResolvedValue(preview);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await GET(getRequest(), context);

    expect(response.status).toBe(401);
    expect(getRoomPreview).not.toHaveBeenCalled();
  });

  it("returns the preview with the top-level is_member flag", async () => {
    const response = await GET(getRequest(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      room: preview,
      is_member: false,
    });
    expect(getRoomPreview).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
  });

  it("answers a non-uuid id with the same 404 a missing room gets", async () => {
    const missing = await GET(getRequest(), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();

    getRoomPreview.mockResolvedValue(null);
    const notFound = await GET(getRequest(), context);
    expect(notFound.status).toBe(404);
    const notFoundBody = await notFound.text();

    // Identical bodies up to the per-request correlation id: private and
    // missing stay indistinguishable (the id reveals nothing about whether
    // the room exists — it is the same value the response header carries).
    const withoutId = (body: string) => {
      const parsed = JSON.parse(body) as { error: Record<string, unknown> };
      delete parsed.error.request_id;
      return JSON.stringify(parsed);
    };
    expect(withoutId(notFoundBody)).toBe(withoutId(missingBody));
    expect(JSON.parse(notFoundBody).error.code).toBe("not_found");
    expect(getRoomPreview).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the data layer reports the room as invisible", async () => {
    getRoomPreview.mockResolvedValue(null);

    const response = await GET(getRequest(), context);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toEqual({
      code: "not_found",
      message: "That room is not available.",
      request_id: expect.any(String),
    });
  });

  it("maps a data-layer validation failure to 400 and other failures to 500", async () => {
    const { DiscoveryError } = await import("@/lib/rooms/discovery");

    getRoomPreview.mockRejectedValue(
      new DiscoveryError("validation", "bad"),
    );
    const badRequest = await GET(getRequest(), context);
    expect(badRequest.status).toBe(400);

    getRoomPreview.mockRejectedValue(new Error("boom"));
    const failed = await GET(getRequest(), context);
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("preview_failed");
  });
});
