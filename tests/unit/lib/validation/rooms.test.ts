import {
  CAPACITY_DEFAULT,
  createRoomSchema,
  roomIdSchema,
  roomCursorActiveSchema,
  roomCursorLargestSchema,
  roomCursorNameSchema,
  roomCursorRecentSchema,
  roomCursorRelevanceSchema,
  roomDiscoverySchema,
  updateRoomSchema,
} from "@/lib/validation/rooms";
import { describe, expect, it } from "vitest";

describe("createRoomSchema", () => {
  it("trims the name and fills in the database defaults", () => {
    const parsed = createRoomSchema.parse({ name: "  Calculus Study Room  " });

    expect(parsed).toEqual({
      name: "Calculus Study Room",
      capacity: CAPACITY_DEFAULT,
      visibility: "public",
      status: "open",
      exam_track: null,
      subject: null,
      language: null,
      shared_goal: null,
    });
  });

  it("requires a name", () => {
    const result = createRoomSchema.safeParse({ name: "   " });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["name"]);
  });

  it("rejects a name longer than the database CHECK allows", () => {
    const result = createRoomSchema.safeParse({ name: "a".repeat(101) });

    expect(result.success).toBe(false);
  });

  it("coerces capacity from a form string and validates its range", () => {
    expect(createRoomSchema.parse({ name: "Room", capacity: "6" }).capacity).toBe(
      6,
    );
    expect(createRoomSchema.safeParse({ name: "Room", capacity: 0 }).success).toBe(
      false,
    );
    expect(
      createRoomSchema.safeParse({ name: "Room", capacity: 101 }).success,
    ).toBe(false);
    expect(
      createRoomSchema.safeParse({ name: "Room", capacity: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects unknown visibility and status values", () => {
    expect(
      createRoomSchema.safeParse({ name: "Room", visibility: "everyone" })
        .success,
    ).toBe(false);
    expect(
      createRoomSchema.safeParse({ name: "Room", status: "archived" }).success,
    ).toBe(false);
  });

  it("normalises blank optional fields to null and enforces their max lengths", () => {
    const parsed = createRoomSchema.parse({
      name: "Room",
      subject: "   ",
      exam_track: "JEE",
    });

    expect(parsed.subject).toBeNull();
    expect(parsed.exam_track).toBe("JEE");

    expect(
      createRoomSchema.safeParse({ name: "Room", exam_track: "a".repeat(81) })
        .success,
    ).toBe(false);
    expect(
      createRoomSchema.safeParse({ name: "Room", subject: "a".repeat(81) })
        .success,
    ).toBe(false);
    expect(
      createRoomSchema.safeParse({ name: "Room", language: "a".repeat(41) })
        .success,
    ).toBe(false);
    expect(
      createRoomSchema.safeParse({ name: "Room", shared_goal: "a".repeat(501) })
        .success,
    ).toBe(false);
  });

  it("never forwards an owner id to the RPC", () => {
    const parsed = createRoomSchema.parse({
      name: "Room",
      owner_id: "someone-else",
      id: "room-id",
    });

    expect(parsed).not.toHaveProperty("owner_id");
    expect(parsed).not.toHaveProperty("id");
  });
});

describe("updateRoomSchema", () => {
  it("accepts a partial body and keeps only the keys that were sent", () => {
    const parsed = updateRoomSchema.parse({ name: "  Renamed  " });
    expect(parsed).toEqual({ name: "Renamed" });
    expect(Object.keys(parsed)).toEqual(["name"]);
  });

  it("parses an empty object but with zero keys, so the route can refuse it", () => {
    const parsed = updateRoomSchema.parse({});
    expect(parsed).toEqual({});
    expect(Object.keys(parsed)).toHaveLength(0);
  });

  it("coerces capacity from a form string and validates the same range as the CHECK", () => {
    expect(updateRoomSchema.parse({ capacity: "7" })).toEqual({ capacity: 7 });
    expect(updateRoomSchema.safeParse({ capacity: 0 }).success).toBe(false);
    expect(updateRoomSchema.safeParse({ capacity: 101 }).success).toBe(false);
    expect(updateRoomSchema.safeParse({ capacity: 2.5 }).success).toBe(false);
  });

  it("accepts only the two database statuses", () => {
    expect(updateRoomSchema.parse({ status: "closed" })).toEqual({
      status: "closed",
    });
    expect(updateRoomSchema.safeParse({ status: "archived" }).success).toBe(
      false,
    );
  });

  it("normalises cleared optional fields to null and keeps blank names invalid", () => {
    expect(
      updateRoomSchema.parse({
        shared_goal: "   ",
        exam_track: "",
        subject: null,
        language: null,
      }),
    ).toEqual({
      shared_goal: null,
      exam_track: null,
      subject: null,
      language: null,
    });

    // A room always has a name: blank is a validation error, not a clear.
    expect(updateRoomSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(updateRoomSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("enforces the per-field length limits after trimming", () => {
    expect(
      updateRoomSchema.safeParse({ name: "a".repeat(101) }).success,
    ).toBe(false);
    expect(
      updateRoomSchema.safeParse({ shared_goal: "a".repeat(501) }).success,
    ).toBe(false);
    expect(
      updateRoomSchema.safeParse({ exam_track: "a".repeat(81) }).success,
    ).toBe(false);
    expect(
      updateRoomSchema.safeParse({ subject: "a".repeat(81) }).success,
    ).toBe(false);
    expect(
      updateRoomSchema.safeParse({ language: "a".repeat(41) }).success,
    ).toBe(false);
  });

  it("refuses identity and immutable fields instead of dropping them quietly", () => {
    for (const key of [
      "owner_id",
      "visibility",
      "id",
      "created_at",
      "updated_at",
    ]) {
      const parsed = updateRoomSchema.safeParse({
        name: "Renamed",
        [key]: "anything",
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) => issue.code === "unrecognized_keys"),
        ).toBe(true);
      }
    }
  });
});

describe("roomDiscoverySchema", () => {
  it("defaults to an empty search with the default page size", () => {
    expect(roomDiscoverySchema.parse({})).toEqual({
      q: "",
      subject: null,
      exam_track: null,
      language: null,
      min_members: 0,
      limit: 20,
    });
  });

  it("trims text filters and normalises blanks to null", () => {
    const parsed = roomDiscoverySchema.parse({
      q: "  calculus ",
      subject: "  Physics ",
      exam_track: "   ",
    });

    expect(parsed.q).toBe("calculus");
    expect(parsed.subject).toBe("Physics");
    expect(parsed.exam_track).toBeNull();
  });

  it("rejects searches longer than the query limit", () => {
    expect(roomDiscoverySchema.safeParse({ q: "a".repeat(101) }).success).toBe(
      false,
    );
  });

  it("coerces and bounds min_members and limit from query strings", () => {
    expect(roomDiscoverySchema.parse({ min_members: "5" }).min_members).toBe(5);
    expect(roomDiscoverySchema.safeParse({ min_members: "-1" }).success).toBe(
      false,
    );
    expect(
      roomDiscoverySchema.safeParse({ min_members: "101" }).success,
    ).toBe(false);

    expect(roomDiscoverySchema.parse({ limit: "10" }).limit).toBe(10);
    expect(roomDiscoverySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(roomDiscoverySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(roomDiscoverySchema.safeParse({ limit: "1.5" }).success).toBe(false);
  });

  it("accepts only the five sort orders and keeps absent as undefined", () => {
    expect(roomDiscoverySchema.parse({ sort: "active" }).sort).toBe("active");
    expect(roomDiscoverySchema.parse({}).sort).toBeUndefined();
    for (const bad of ["popular", "ACTIVE", "1", ""]) {
      expect(roomDiscoverySchema.safeParse({ sort: bad }).success).toBe(false);
    }
  });

  it("caps the cursor length so oversized values stop at the edge", () => {
    expect(
      roomDiscoverySchema.safeParse({ cursor: "a".repeat(2001) }).success,
    ).toBe(false);
    expect(
      roomDiscoverySchema.parse({ cursor: "eyJmb28iOjF9" }).cursor,
    ).toBe("eyJmb28iOjF9");
  });
});

describe("room cursor schemas", () => {
  const ROOM_UUID = "11111111-1111-4111-8111-111111111111";

  it("accepts the documented payload for each sort", () => {
    expect(
      roomCursorRecentSchema.parse({ c: "2026-10-01T00:00:00Z", i: ROOM_UUID }),
    ).toEqual({ c: "2026-10-01T00:00:00Z", i: ROOM_UUID });
    expect(
      roomCursorActiveSchema.parse({ c: null, i: ROOM_UUID }),
    ).toEqual({ c: null, i: ROOM_UUID });
    expect(roomCursorLargestSchema.parse({ m: 3, i: ROOM_UUID })).toEqual({
      m: 3,
      i: ROOM_UUID,
    });
    expect(roomCursorNameSchema.parse({ n: "Alpha", i: ROOM_UUID })).toEqual({
      n: "Alpha",
      i: ROOM_UUID,
    });
    expect(
      roomCursorRelevanceSchema.parse({ r: 1, m: 2, i: ROOM_UUID }),
    ).toEqual({ r: 1, m: 2, i: ROOM_UUID });
  });

  it("rejects foreign ids, missing keys, and out-of-range ranks", () => {
    expect(
      roomCursorRecentSchema.safeParse({ c: "2026-10-01T00:00:00Z", i: "x" })
        .success,
    ).toBe(false);
    expect(roomCursorRecentSchema.safeParse({ i: ROOM_UUID }).success).toBe(
      false,
    );
    expect(
      roomCursorRelevanceSchema.safeParse({ r: 9, m: 1, i: ROOM_UUID })
        .success,
    ).toBe(false);
    expect(roomCursorNameSchema.safeParse({ n: "", i: ROOM_UUID }).success).toBe(
      false,
    );
  });
});

describe("roomIdSchema", () => {
  it("accepts a UUID", () => {
    expect(roomIdSchema.safeParse("11111111-1111-4111-8111-111111111111").success).toBe(
      true,
    );
  });

  it("rejects anything that is not a UUID so bad ids stop at the route", () => {
    for (const value of ["", "not-a-uuid", "room-1", "1; drop table rooms"]) {
      expect(roomIdSchema.safeParse(value).success).toBe(false);
    }
  });
});
