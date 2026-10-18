import { GET, POST } from "@/app/api/rooms/route";
import { RoomError } from "@/lib/rooms/create";
import { encodeRoomCursor, resolveDiscoverySort } from "@/lib/rooms/discovery";
import type { RoomSummary } from "@/lib/rooms/types";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, searchPublicRooms, getProfile, createRoom } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    searchPublicRooms: vi.fn(),
    getProfile: vi.fn(),
    createRoom: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/rooms/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/discovery")>()),
  searchPublicRooms,
}));

vi.mock("@/lib/profiles/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profiles/queries")>()),
  getProfile,
}));

vi.mock("@/lib/rooms/create", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/create")>()),
  createRoom,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const summary: RoomSummary = {
  id: ROOM_ID,
  name: "Calculus Study Room",
  exam_track: "JEE",
  subject: "Mathematics",
  language: "English",
  capacity: 6,
  status: "open",
  shared_goal: "Finish the syllabus",
  created_at: "2026-10-06T00:00:00.000Z",
  member_count: 2,
  last_activity_at: null,
  viewer_role: null,
  viewer_membership: "none",
};

const room = {
  id: ROOM_ID,
  name: "Calculus Study Room",
  exam_track: "JEE",
  subject: "Mathematics",
  language: "English",
  capacity: 6,
  status: "open",
  shared_goal: "Finish the syllabus",
  created_at: "2026-10-06T00:00:00.000Z",
};

function getRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

function postRequest(body: string) {
  return new NextRequest("http://localhost:3000/api/rooms", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/rooms", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    searchPublicRooms.mockResolvedValue({
      rooms: [summary],
      has_more: false,
      next_cursor: null,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await GET(getRequest("/api/rooms"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthenticated",
        message: expect.any(String),
        request_id: expect.any(String),
      },
    });
    expect(searchPublicRooms).not.toHaveBeenCalled();
  });

  it("returns the shaped rooms with href and pagination fields", async () => {
    const response = await GET(getRequest("/api/rooms"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      rooms: [{ ...summary, href: `/rooms/${ROOM_ID}/preview` }],
      has_more: false,
      next_cursor: null,
    });
    expect(searchPublicRooms).toHaveBeenCalledWith(
      expect.anything(),
      {
        q: "",
        subject: null,
        exam_track: null,
        language: null,
        min_members: 0,
        sort: undefined,
        limit: 20,
        cursor: undefined,
      },
      undefined,
    );
  });

  it("forwards the whole discovery query in one data-layer call", async () => {
    await GET(
      getRequest(
        "/api/rooms?q=neet&subject=Biology&exam_track=NEET&language=Hinglish&min_members=2&sort=largest&limit=10",
      ),
    );

    expect(searchPublicRooms).toHaveBeenCalledTimes(1);
    expect(searchPublicRooms).toHaveBeenCalledWith(
      expect.anything(),
      {
        q: "neet",
        subject: "Biology",
        exam_track: "NEET",
        language: "Hinglish",
        min_members: 2,
        sort: "largest",
        limit: 10,
        cursor: undefined,
      },
      undefined,
    );
  });

  it("rejects an over-long query with 400", async () => {
    const response = await GET(getRequest(`/api/rooms?q=${"a".repeat(101)}`));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.issues[0].path).toBe("q");
    expect(searchPublicRooms).not.toHaveBeenCalled();
  });

  it("rejects an unsupported sort and an out-of-range limit with 400", async () => {
    const badSort = await GET(getRequest("/api/rooms?sort=popular"));
    expect(badSort.status).toBe(400);
    expect((await badSort.json()).error.code).toBe("validation");

    const badLimit = await GET(getRequest("/api/rooms?limit=500"));
    expect(badLimit.status).toBe(400);

    expect(searchPublicRooms).not.toHaveBeenCalled();
  });

  it("hands the opaque cursor string to the data layer, which owns its shape", async () => {
    // Decoding and per-sort validation live in `searchPublicRooms`, so the
    // route forwards whatever it got; a bad one surfaces as a 400 through
    // the validation mapping below (and is unit-tested at the data layer).
    searchPublicRooms.mockResolvedValue({ rooms: [], has_more: false, next_cursor: null });
    const response = await GET(getRequest("/api/rooms?cursor=garbage!!"));

    expect(response.status).toBe(200);
    expect(searchPublicRooms).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "garbage!!",
    );
  });

  it("replays a well-formed cursor to the data layer", async () => {
    const cursor = encodeRoomCursor("recent", {
      id: ROOM_ID,
      name: "x",
      shared_goal: null,
      subject: null,
      exam_track: null,
      language: null,
      status: "open",
      capacity: 4,
      member_count: 1,
      last_activity_at: null,
      viewer_role: null,
      created_at: "2026-10-06T00:00:00.000Z",
    }, "");

    searchPublicRooms.mockResolvedValue({ rooms: [], has_more: false, next_cursor: null });
    const response = await GET(
      getRequest(`/api/rooms?cursor=${encodeURIComponent(cursor)}`),
    );

    expect(response.status).toBe(200);
    const [, search, passedCursor] = searchPublicRooms.mock.calls[0];
    expect(passedCursor).toBe(cursor);
    expect(resolveDiscoverySort(search)).toBe("recent");
  });

  it("maps a data-layer validation failure to 400", async () => {
    const { DiscoveryError } = await import("@/lib/rooms/discovery");
    searchPublicRooms.mockRejectedValue(
      new DiscoveryError("validation", "Those search options are not valid."),
    );

    const response = await GET(getRequest("/api/rooms"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
  });

  it("returns 500 when the query fails", async () => {
    searchPublicRooms.mockRejectedValue(new Error("connection lost"));

    const response = await GET(getRequest("/api/rooms"));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("query_failed");
  });
});

describe("POST /api/rooms", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    getProfile.mockResolvedValue({ id: "user-1", alias: "examnerd" });
    createRoom.mockResolvedValue(room);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await POST(postRequest(JSON.stringify({ name: "Room" })));

    expect(response.status).toBe(401);
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON with 400", async () => {
    const response = await POST(postRequest("{not json"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("rejects invalid room fields with 400 and lists the issues", async () => {
    const response = await POST(postRequest(JSON.stringify({ capacity: 0 })));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.issues.map((issue: { path: string }) => issue.path)).toEqual(
      ["name", "capacity"],
    );
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("requires an onboarding alias with 403", async () => {
    getProfile.mockResolvedValue(null);

    const response = await POST(postRequest(JSON.stringify({ name: "Room" })));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("onboarding_required");
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("creates the room from validated input only", async () => {
    const response = await POST(
      postRequest(
        JSON.stringify({
          name: "  Calculus Study Room  ",
          capacity: "6",
          subject: "Mathematics",
          owner_id: "someone-else",
        }),
      ),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ room });
    expect(createRoom).toHaveBeenCalledWith(expect.anything(), {
      name: "Calculus Study Room",
      capacity: 6,
      visibility: "public",
      exam_track: null,
      subject: "Mathematics",
      language: null,
      shared_goal: null,
      status: "open",
    });
  });

  it("maps RoomError onto its status and code", async () => {
    createRoom.mockRejectedValue(
      new RoomError(
        "permission_denied",
        "You do not have permission to create this room.",
        403,
      ),
    );

    const response = await POST(postRequest(JSON.stringify({ name: "Room" })));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "permission_denied",
        message: "You do not have permission to create this room.",
        request_id: expect.any(String),
      },
    });
  });

  it("returns 500 for an unexpected create failure", async () => {
    createRoom.mockRejectedValue(new Error("boom"));

    const response = await POST(postRequest(JSON.stringify({ name: "Room" })));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("rpc_failed");
  });

  it("returns 500 when the profile lookup fails", async () => {
    getProfile.mockRejectedValue(new Error("connection lost"));

    const response = await POST(postRequest(JSON.stringify({ name: "Room" })));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("query_failed");
    expect(createRoom).not.toHaveBeenCalled();
  });
});
