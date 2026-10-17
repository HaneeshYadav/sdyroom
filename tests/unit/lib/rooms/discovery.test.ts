import {
  decodeRoomCursor,
  DiscoveryError,
  discoveryErrorStatus,
  encodeRoomCursor,
  getRoomFilterOptions,
  getRoomPreview,
  relevanceRank,
  resolveDiscoverySort,
  searchPublicRooms,
  toRoomSummary,
  toViewerMembership,
} from "@/lib/rooms/discovery";
import type { DiscoveredRoom } from "@/lib/rooms/types";
import type { RoomSearchInput } from "@/lib/validation/rooms";
import { createFakeClient } from "../../helpers/fake-supabase";
import { describe, expect, it } from "vitest";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const discoveredRow = {
  id: ROOM_ID,
  name: "Alpha Physics",
  shared_goal: "Finish mechanics",
  subject: "Physics",
  exam_track: "JEE",
  language: "English",
  status: "open",
  capacity: 6,
  member_count: 3,
  last_activity_at: "2026-10-01T12:00:00.000Z",
  viewer_role: null,
  created_at: "2026-09-20T00:00:00.000Z",
};

function discovered(overrides: Partial<DiscoveredRoom> = {}): DiscoveredRoom {
  return {
    id: ROOM_ID,
    name: "Alpha Physics",
    shared_goal: null,
    subject: "Physics",
    exam_track: "JEE",
    language: "English",
    status: "open",
    capacity: 6,
    member_count: 2,
    last_activity_at: null,
    viewer_role: null,
    created_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

function search(overrides: Partial<RoomSearchInput> = {}): RoomSearchInput {
  return {
    q: "",
    subject: null,
    exam_track: null,
    language: null,
    min_members: 0,
    sort: undefined,
    limit: 20,
    ...overrides,
  };
}

describe("resolveDiscoverySort", () => {
  it("defaults to relevance for a query and recent without one", () => {
    expect(resolveDiscoverySort(search({ q: "physics" }))).toBe("relevance");
    expect(resolveDiscoverySort(search())).toBe("recent");
  });

  it("lets an explicit sort win over the default", () => {
    expect(resolveDiscoverySort(search({ q: "physics", sort: "name" }))).toBe(
      "name",
    );
    expect(resolveDiscoverySort(search({ sort: "largest" }))).toBe("largest");
  });
});

describe("relevanceRank", () => {
  it("ranks exact, prefix, then the rest — case-insensitively", () => {
    expect(relevanceRank("Alpha Physics", "alpha physics")).toBe(0);
    expect(relevanceRank("Alpha Physics", "ALPHA")).toBe(1);
    expect(relevanceRank("Alphabet Physics", "alpha")).toBe(1);
    expect(relevanceRank("Biology Base", "alpha")).toBe(2);
  });
});

describe("cursor round trip", () => {
  it("encodes and decodes every sort's keyset", () => {
    const room = discovered({
      member_count: 4,
      last_activity_at: "2026-10-01T12:00:00.000Z",
      viewer_role: "student",
    });

    const recent = encodeRoomCursor("recent", room, "");
    expect(decodeRoomCursor("recent", recent)).toEqual({
      c: room.created_at,
      i: ROOM_ID,
    });

    const active = encodeRoomCursor("active", room, "");
    expect(decodeRoomCursor("active", active)).toEqual({
      c: room.last_activity_at,
      i: ROOM_ID,
    });

    const nullActivity = encodeRoomCursor("active", discovered(), "");
    expect(decodeRoomCursor("active", nullActivity)).toEqual({
      c: null,
      i: ROOM_ID,
    });

    const largest = encodeRoomCursor("largest", room, "");
    expect(decodeRoomCursor("largest", largest)).toEqual({ m: 4, i: ROOM_ID });

    const name = encodeRoomCursor("name", room, "");
    expect(decodeRoomCursor("name", name)).toEqual({
      n: "Alpha Physics",
      i: ROOM_ID,
    });

    const relevance = encodeRoomCursor("relevance", room, "alpha physics");
    expect(decodeRoomCursor("relevance", relevance)).toEqual({
      r: 0,
      m: 4,
      i: ROOM_ID,
    });
  });

  it("rejects truncated, foreign and cross-sort cursors with validation", () => {
    for (const bad of ["not-base64-json", "", "%%%"]) {
      expect(() => decodeRoomCursor("recent", bad)).toThrow(DiscoveryError);
    }

    // A largest cursor replayed against recent lacks c/i.
    const largest = encodeRoomCursor(
      "largest",
      discovered({ member_count: 1 }),
      "",
    );
    expect(() => decodeRoomCursor("recent", largest)).toThrow(DiscoveryError);

    const foreign = Buffer.from(
      JSON.stringify({ c: "2026-10-01T00:00:00Z", i: "not-a-uuid" }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeRoomCursor("recent", foreign)).toThrow(DiscoveryError);
  });

  it("maps decode failures to a 400 status code", () => {
    try {
      decodeRoomCursor("name", "garbage");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DiscoveryError);
      expect((error as DiscoveryError).code).toBe("validation");
      expect(discoveryErrorStatus(error as DiscoveryError)).toBe(400);
    }
  });
});

describe("toRoomSummary", () => {
  it("maps viewer_role into the membership vocabulary", () => {
    expect(toRoomSummary(discovered({ viewer_role: "owner" })).viewer_membership).toBe("owner");
    expect(
      toRoomSummary(discovered({ viewer_role: "student" })).viewer_membership,
    ).toBe("member");
    expect(toRoomSummary(discovered()).viewer_membership).toBe("none");
  });

  it("maps viewer_role with a null-safe helper", () => {
    expect(toViewerMembership("owner")).toBe("owner");
    expect(toViewerMembership("student")).toBe("member");
    expect(toViewerMembership(null)).toBe("none");
  });
});

describe("searchPublicRooms", () => {
  it("calls the RPC once with normalised parameters and shapes the page", async () => {
    const { client, rpcCalls } = createFakeClient({ data: [discoveredRow] });

    const page = await searchPublicRooms(
      client as never,
      search({ q: "alpha", subject: "Physics", limit: 20 }),
    );

    expect(rpcCalls).toEqual([
      {
        fn: "list_public_rooms",
        args: {
          p_q: "alpha",
          p_subject: "Physics",
          p_exam_track: null,
          p_language: null,
          p_min_members: 0,
          p_sort: "relevance",
          p_limit: 20,
          p_cursor: null,
        },
      },
    ]);
    expect(page.rooms).toHaveLength(1);
    expect(page.rooms[0]).toMatchObject({
      id: ROOM_ID,
      name: "Alpha Physics",
      subject: "Physics",
      member_count: 3,
      viewer_membership: "none",
      last_activity_at: "2026-10-01T12:00:00.000Z",
    });
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
  });

  it("trims an empty query to a null p_q and defaults the sort to recent", async () => {
    const { client, rpcCalls } = createFakeClient({ data: [] });

    await searchPublicRooms(client as never, search({ q: "   " }));

    expect(rpcCalls[0]).toEqual({
      fn: "list_public_rooms",
      args: expect.objectContaining({ p_q: null, p_sort: "recent" }),
    });
  });

  it("drops the overflow row into has_more and a cursor for the next page", async () => {
    const rows = [
      discoveredRow,
      { ...discoveredRow, id: "22222222-2222-4222-8222-222222222222", name: "Beta" },
    ];
    const { client } = createFakeClient({ data: rows });

    const page = await searchPublicRooms(client as never, search({ limit: 1 }));

    expect(page.rooms).toHaveLength(1);
    expect(page.rooms[0].name).toBe("Alpha Physics");
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).not.toBeNull();
    expect(decodeRoomCursor("recent", page.next_cursor as string)).toEqual({
      c: discoveredRow.created_at,
      i: discoveredRow.id,
    });
  });

  it("replays a decoded cursor through to the RPC", async () => {
    const { client, rpcCalls } = createFakeClient({ data: [] });
    const cursor = encodeRoomCursor("recent", discovered(), "");

    await searchPublicRooms(client as never, search(), cursor);

    expect((rpcCalls[0].args as { p_cursor: unknown }).p_cursor).toEqual({
      c: discovered().created_at,
      i: ROOM_ID,
    });
  });

  it("rejects a malformed cursor before the RPC is called", async () => {
    const { client, rpcCalls } = createFakeClient({ data: [] });

    await expect(
      searchPublicRooms(client as never, search(), "garbage!!"),
    ).rejects.toMatchObject({ code: "validation" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("maps the database input refusal (22023) to validation", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "22023", message: "invalid sort" },
    });

    await expect(searchPublicRooms(client as never, search())).rejects.toMatchObject(
      { code: "validation" },
    );
  });

  it("turns any other RPC failure into query_failed, never an empty page", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "XX000", message: "connection lost" },
    });

    await expect(searchPublicRooms(client as never, search())).rejects.toMatchObject(
      { code: "query_failed" },
    );
  });
});

describe("getRoomPreview", () => {
  it("returns the shaped preview for a public room", async () => {
    const { client, rpcCalls } = createFakeClient({
      data: [
        {
          ...discoveredRow,
          visibility: "public",
          is_member: false,
          viewer_role: null,
        },
      ],
    });

    const room = await getRoomPreview(client as never, ROOM_ID);

    expect(rpcCalls).toEqual([
      { fn: "room_preview", args: { p_room_id: ROOM_ID } },
    ]);
    expect(room).toMatchObject({
      id: ROOM_ID,
      name: "Alpha Physics",
      visibility: "public",
      is_member: false,
      viewer_role: null,
    });
  });

  it("returns null on P0002 — private or missing, indistinguishable", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "P0002", message: "room not found" },
    });

    expect(await getRoomPreview(client as never, ROOM_ID)).toBeNull();
  });

  it("returns null when the RPC somehow yields no row", async () => {
    const { client } = createFakeClient({ data: [] });
    expect(await getRoomPreview(client as never, ROOM_ID)).toBeNull();
  });

  it("turns other failures into query_failed", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "XX000", message: "boom" },
    });

    await expect(getRoomPreview(client as never, ROOM_ID)).rejects.toMatchObject(
      { code: "query_failed" },
    );
  });
});

describe("getRoomFilterOptions", () => {
  it("returns the three option lists", async () => {
    const { client } = createFakeClient({
      data: {
        subjects: ["Physics", "Biology"],
        exam_tracks: ["JEE"],
        languages: ["English", "Hinglish"],
      },
    });

    expect(await getRoomFilterOptions(client as never)).toEqual({
      subjects: ["Physics", "Biology"],
      exam_tracks: ["JEE"],
      languages: ["English", "Hinglish"],
    });
  });

  it("degrades malformed lists to empty arrays", async () => {
    const { client } = createFakeClient({ data: { subjects: "oops" } });

    expect(await getRoomFilterOptions(client as never)).toEqual({
      subjects: [],
      exam_tracks: [],
      languages: [],
    });
  });

  it("turns RPC failures into query_failed", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "boom" },
    });

    await expect(getRoomFilterOptions(client as never)).rejects.toMatchObject({
      code: "query_failed",
    });
  });
});
