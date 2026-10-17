import {
  deleteRoom,
  getOwnedRoom,
  RoomMutationError,
  RoomQueryError,
  updateRoom,
} from "@/lib/rooms/queries";
import { PUBLIC_ROOM_COLUMNS } from "@/lib/rooms/types";
import { createFakeClient } from "../../helpers/fake-supabase";
import { describe, expect, it } from "vitest";

const row = {
  id: "room-1",
  name: "Calculus Study Room",
  exam_track: "JEE",
  subject: "Mathematics",
  language: "English",
  capacity: 6,
  status: "open",
  shared_goal: "Finish the syllabus",
  created_at: "2026-10-06T00:00:00.000Z",
};

describe("getOwnedRoom", () => {
  const roomRow = {
    ...row,
    owner_id: "user-1",
    visibility: "private",
  };

  it("reads only the public columns for the room, then the caller's own role", async () => {
    const { client, state } = createFakeClient({ data: null }, [
      { data: roomRow },
      { data: [{ role: "owner" }] },
    ]);

    const room = await getOwnedRoom(client as never, "room-1");

    expect(client.from).toHaveBeenNthCalledWith(1, "rooms");
    expect(client.from).toHaveBeenNthCalledWith(2, "room_members");
    expect(state.select[0]).toBe(PUBLIC_ROOM_COLUMNS);
    expect(state.select[1]).toBe("role");
    expect(state.eq[0]).toEqual(["id", "room-1"]);
    expect(state.eq[1]).toEqual(["room_id", "room-1"]);
    expect(state.limit).toEqual([1]);
    expect(room).not.toBeNull();
    expect(room && "owner_id" in room).toBe(false);
    expect(room && "visibility" in room).toBe(false);
  });

  it("returns null when the room row is invisible (non-member or missing)", async () => {
    const { client } = createFakeClient({ data: null }, [{ data: null }]);

    expect(await getOwnedRoom(client as never, "room-1")).toBeNull();
    // The membership read must not even run.
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it("returns null for a member who is not the owner", async () => {
    const { client } = createFakeClient({ data: null }, [
      { data: roomRow },
      { data: [{ role: "student" }] },
    ]);

    expect(await getOwnedRoom(client as never, "room-1")).toBeNull();
  });

  it("returns null when the membership list comes back empty", async () => {
    const { client } = createFakeClient({ data: null }, [
      { data: roomRow },
      { data: [] },
    ]);

    expect(await getOwnedRoom(client as never, "room-1")).toBeNull();
  });

  it("throws a RoomQueryError when either read fails", async () => {
    const { client } = createFakeClient({ data: null }, [
      { data: null, error: { message: "permission denied" } },
    ]);
    await expect(getOwnedRoom(client as never, "room-1")).rejects.toThrow(
      RoomQueryError,
    );

    const { client: client2 } = createFakeClient({ data: null }, [
      { data: roomRow },
      { data: null, error: { message: "permission denied" } },
    ]);
    await expect(getOwnedRoom(client2 as never, "room-1")).rejects.toThrow(
      RoomQueryError,
    );
  });
});

describe("updateRoom", () => {
  it("sends only the keys that were present, keeping cleared values distinct", async () => {
    const { client, rpcCalls } = createFakeClient({ data: { code: "updated", ...row } });

    await updateRoom(client as never, "room-1", {
      name: "Renamed",
      shared_goal: null,
    });

    expect(rpcCalls).toEqual([
      {
        fn: "update_room",
        args: {
          p_room_id: "room-1",
          p_changes: { name: "Renamed", shared_goal: null },
        },
      },
    ]);
  });

  it("maps every envelope failure onto its HTTP status", async () => {
    const cases: [string, string, number][] = [
      ["room_not_found", "not_found", 404],
      ["not_owner", "not_owner", 403],
      ["invalid_request", "invalid_request", 400],
      ["validation", "validation", 400],
    ];

    for (const [code, expectedCode, status] of cases) {
      const { client } = createFakeClient({ data: { code } });
      const error = await updateRoom(client as never, "room-1", {
        name: "Renamed",
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RoomMutationError);
      expect((error as RoomMutationError).code).toBe(expectedCode);
      expect((error as RoomMutationError).status).toBe(status);
    }
  });

  it("carries the member count on the capacity floor refusal", async () => {
    const { client } = createFakeClient({
      data: { code: "capacity_below_membership", member_count: 4 },
    });

    const error = await updateRoom(client as never, "room-1", {
      capacity: 1,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RoomMutationError);
    expect((error as RoomMutationError).code).toBe("capacity_below_membership");
    expect((error as RoomMutationError).status).toBe(409);
    expect((error as RoomMutationError).memberCount).toBe(4);
    expect((error as Error).message).toContain("4");
  });

  it("throws instead of forwarding an envelope code it does not know", async () => {
    const { client } = createFakeClient({ data: { code: "exploded" } });

    await expect(
      updateRoom(client as never, "room-1", { name: "Renamed" }),
    ).rejects.toThrow(/unexpected room mutation code/);
  });

  it("turns transport errors and empty results into plain Errors for the route", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "syntax error" },
    });
    await expect(
      updateRoom(client as never, "room-1", { name: "Renamed" }),
    ).rejects.toThrow(/update_room failed/);

    const { client: client2 } = createFakeClient({ data: null });
    await expect(
      updateRoom(client2 as never, "room-1", { name: "Renamed" }),
    ).rejects.toThrow(/returned no result/);
  });
});

describe("deleteRoom", () => {
  it("calls delete_room with the room id and resolves on success", async () => {
    const { client, rpcCalls } = createFakeClient({ data: { code: "deleted" } });

    await expect(deleteRoom(client as never, "room-1")).resolves.toBeUndefined();
    expect(rpcCalls).toEqual([
      { fn: "delete_room", args: { p_room_id: "room-1" } },
    ]);
  });

  it("maps the owner and existence failures", async () => {
    const { client } = createFakeClient({ data: { code: "room_not_found" } });
    const error = await deleteRoom(client as never, "room-1").catch((e) => e);
    expect(error).toBeInstanceOf(RoomMutationError);
    expect((error as RoomMutationError).code).toBe("not_found");
    expect((error as RoomMutationError).status).toBe(404);

    const { client: client2 } = createFakeClient({ data: { code: "not_owner" } });
    const error2 = await deleteRoom(client2 as never, "room-1").catch((e) => e);
    expect((error2 as RoomMutationError).code).toBe("not_owner");
    expect((error2 as RoomMutationError).status).toBe(403);
  });

  it("throws on transport errors, empty results, and unknown codes", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "syntax error" },
    });
    await expect(deleteRoom(client as never, "room-1")).rejects.toThrow(
      /delete_room failed/,
    );

    const { client: client2 } = createFakeClient({ data: null });
    await expect(deleteRoom(client2 as never, "room-1")).rejects.toThrow(
      /returned no result/,
    );

    const { client: client3 } = createFakeClient({ data: { code: "mystery" } });
    await expect(deleteRoom(client3 as never, "room-1")).rejects.toThrow(
      /unexpected room mutation code/,
    );
  });
});
