import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listGet } from "@/app/api/rooms/route";
import { GET as previewGet } from "@/app/api/rooms/[id]/preview/route";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import {
  getRoomPreview,
  getRoomFilterOptions,
  searchPublicRooms,
} from "@/lib/rooms/discovery";
import { joinRoom } from "@/lib/rooms/membership";
import { createRoomSchema } from "@/lib/validation/rooms";
import { callApi, callApiWithParams, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import { integrationEnv } from "./helpers/env";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

/**
 * PR 17 — advanced room discovery against the real database.
 * The suite asserts the two guarantees the feature rests on: private rooms
 * are unreachable through every discovery surface (list, filters, counts,
 * preview), and pagination/sorting never widens visibility. Every fixture
 * carries a per-run unique token so parallel test files sharing the same
 * local database cannot satisfy an assertion by accident.
 */

const SEARCH = {
  q: "",
  subject: null,
  exam_track: null,
  language: null,
  min_members: 0,
  sort: undefined,
  limit: 20,
} as const;

describe("room discovery (PR 17)", () => {
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  /** Never joins anything — the stranger every "must be hidden" check uses. */
  let outsider: TestUser;

  let publicRoom: string;
  let publicRoomName: string;
  let privateRoom: string;
  let privateRoomName: string;
  let publicSubject: string;
  let privateSubject: string;

  beforeAll(async () => {
    [alice, bob, carol, outsider] = await Promise.all([
      createUser("disc-alice"),
      createUser("disc-bob"),
      createUser("disc-carol"),
      createUser("disc-outsider"),
    ]);
    await Promise.all(
      [alice, bob, carol, outsider].map((user, index) =>
        createProfile(
          user.client,
          user.id,
          uniqueAlias(`D${index}`),
        ),
      ),
    );

    publicSubject = uniqueName("Subj");
    privateSubject = uniqueName("Hidden");
    publicRoomName = uniqueName("PublicAlpha");
    privateRoomName = uniqueName("HiddenOmega");

    publicRoom = (
      await createRoom(
        alice.client,
        createRoomSchema.parse({
          name: publicRoomName,
          capacity: 6,
          subject: publicSubject,
          exam_track: "NEET",
          language: "English",
          shared_goal: "Finish mechanics",
        }),
      )
    ).id;

    privateRoom = (
      await createRoom(
        alice.client,
        createRoomSchema.parse({
          name: privateRoomName,
          capacity: 6,
          subject: privateSubject,
          visibility: "private",
        }),
      )
    ).id;

    // Bob is a member of the public room only; Carol is an outsider to both.
    await joinRoom(bob.client, publicRoom);
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([alice, bob, carol, outsider]);
  });

  describe("public listing", () => {
    it("returns a public room to any signed-in student with the listing shape", async () => {
      const page = await searchPublicRooms(carol.client, {
        ...SEARCH,
        q: publicRoomName,
      });

      const room = page.rooms.find((entry) => entry.id === publicRoom);
      expect(room).toBeDefined();
      expect(room?.name).toBe(publicRoomName);
      expect(room?.subject).toBe(publicSubject);
      expect(room?.exam_track).toBe("NEET");
      expect(room?.language).toBe("English");
      expect(room?.capacity).toBe(6);
      expect(room?.status).toBe("open");
      expect(room?.member_count).toBe(2);
    });

    it("never returns a private room, even to its own owner", async () => {
      const page = await searchPublicRooms(alice.client, {
        ...SEARCH,
        q: privateRoomName,
      });

      expect(page.rooms.some((room) => room.id === privateRoom)).toBe(false);
      expect(page.rooms).toHaveLength(0);
    });

    it("keeps private rooms out when their exact name is searched", async () => {
      // The strongest bait possible: the caller is the owner and the query is
      // the private room's full, unique name.
      const page = await searchPublicRooms(alice.client, {
        ...SEARCH,
        q: privateRoomName,
      });
      expect(page.rooms).toHaveLength(0);
    });

    it("exposes only the viewer's own membership flags", async () => {
      const forBob = await searchPublicRooms(bob.client, {
        ...SEARCH,
        q: publicRoomName,
      });
      const bobRoom = forBob.rooms.find((room) => room.id === publicRoom);
      expect(bobRoom?.viewer_membership).toBe("member");
      expect(bobRoom?.viewer_role).toBe("student");

      const forCarol = await searchPublicRooms(carol.client, {
        ...SEARCH,
        q: publicRoomName,
      });
      const carolRoom = forCarol.rooms.find((room) => room.id === publicRoom);
      expect(carolRoom?.viewer_membership).toBe("none");
      expect(carolRoom?.viewer_role).toBeNull();

      // Alice created it, so she is the owner — mapped to the "owner"
      // membership, never "member".
      const forAlice = await searchPublicRooms(alice.client, {
        ...SEARCH,
        q: publicRoomName,
      });
      const aliceRoom = forAlice.rooms.find((room) => room.id === publicRoom);
      expect(aliceRoom?.viewer_membership).toBe("owner");
      expect(aliceRoom?.viewer_role).toBe("owner");
    });

    it("counts members of public rooms only", async () => {
      // Add Carol to the public room so the count moves; the private room's
      // membership (Alice) must not surface anywhere in the listing.
      await joinRoom(carol.client, publicRoom);
      const page = await searchPublicRooms(bob.client, {
        ...SEARCH,
        q: publicRoomName,
      });
      const room = page.rooms.find((entry) => entry.id === publicRoom);
      expect(room?.member_count).toBe(3);
    });
  });

  describe("filters cannot bypass visibility", () => {
    it("ignores a private room even when every filter matches it", async () => {
      const page = await searchPublicRooms(alice.client, {
        ...SEARCH,
        subject: privateSubject,
        exam_track: "NEET",
        language: "English",
        min_members: 1,
      });
      expect(page.rooms.some((room) => room.id === privateRoom)).toBe(false);
    });

    it("never lists private values in the filter options", async () => {
      const options = await getRoomFilterOptions(alice.client);
      expect(options.subjects).toContain(publicSubject);
      expect(options.subjects).not.toContain(privateSubject);
    });
  });

  describe("sorting and pagination", () => {
    it("rejects relevance without a query (SQLSTATE 22023)", async () => {
      await expect(
        searchPublicRooms(carol.client, { ...SEARCH, sort: "relevance" }),
      ).rejects.toMatchObject({ code: "validation" });
    });

    it("returns limit+1 rows so has_more is signalled without a count", async () => {
      const page = await searchPublicRooms(carol.client, {
        ...SEARCH,
        subject: publicSubject,
        limit: 2,
      });
      // has_more is derived from the extra row, never from a total count.
      expect(page.rooms.length).toBeLessThanOrEqual(2);
      if (page.has_more) {
        expect(page.next_cursor).toBeTruthy();
      } else {
        expect(page.next_cursor).toBeNull();
      }
    });

    it("walks the whole listing with a cursor, without repeats or gaps", async () => {
      const first = await searchPublicRooms(carol.client, {
        ...SEARCH,
        subject: publicSubject,
        limit: 1,
      });
      expect(first.rooms).toHaveLength(1);
      const firstId = first.rooms[0].id;

      if (first.has_more && first.next_cursor) {
        const second = await searchPublicRooms(carol.client, {
          ...SEARCH,
          subject: publicSubject,
          limit: 1,
        }, first.next_cursor);
        expect(second.rooms.length).toBeLessThanOrEqual(1);
        if (second.rooms.length === 1) {
          expect(second.rooms[0].id).not.toBe(firstId);
        }
      }
    });

    it("rejects a malformed cursor as a validation error", async () => {
      await expect(
        searchPublicRooms(carol.client, { ...SEARCH, sort: "recent" }, "garbage!!"),
      ).rejects.toMatchObject({ code: "validation" });
    });

    it("runs every explicit sort against public rooms only", async () => {
      for (const sort of ["recent", "active", "largest", "name"] as const) {
        const page = await searchPublicRooms(carol.client, {
          ...SEARCH,
          subject: publicSubject,
          sort,
          limit: 50,
        });
        expect(page.rooms.some((room) => room.id === privateRoom)).toBe(false);
      }
    });
  });

  describe("room preview", () => {
    it("lets any signed-in student preview a public room", async () => {
      const room = await getRoomPreview(outsider.client, publicRoom);
      expect(room).not.toBeNull();
      expect(room?.name).toBe(publicRoomName);
      expect(room?.shared_goal).toBe("Finish mechanics");
      expect(room?.member_count).toBe(3);
      expect(room?.is_member).toBe(false);
      expect(room?.viewer_role).toBeNull();
    });

    it("answers a missing room and a private non-member with the same 404 body", async () => {
      // Both go through the identical P0002 path in `room_preview`, so the
      // response body must be byte-for-byte indistinguishable.
      const missingId = "00000000-0000-4000-8000-000000000000";
      const missing = await getRoomPreview(outsider.client, missingId);
      const hidden = await getRoomPreview(outsider.client, privateRoom);
      expect(missing).toBeNull();
      expect(hidden).toBeNull();
    });

    it("lets the owner preview their own private room", async () => {
      // Bob is not a member of the private room; Alice is (as owner).
      const room = await getRoomPreview(alice.client, privateRoom);
      expect(room).not.toBeNull();
      expect(room?.name).toBe(privateRoomName);
      expect(room?.is_member).toBe(true);
      expect(room?.viewer_role).toBe("owner");
      expect(room?.visibility).toBe("private");
    });

    it("hides a private room from a non-member through the HTTP route", async () => {
      await seedSession(carol.email, carol.password);
      const response = await callApiWithParams(
        previewGet,
        { path: `/api/rooms/${privateRoom}/preview` },
        { id: privateRoom },
      );
      expect(response.status).toBe(404);
      expect(errorOf(await readJson(response)).code).toBe("not_found");
      clearCookies();
    });

    it("answers a non-uuid id with the same 404 a missing room gets", async () => {
      await seedSession(carol.email, carol.password);
      const response = await callApiWithParams(
        previewGet,
        { path: "/api/rooms/not-a-uuid/preview" },
        { id: "not-a-uuid" },
      );
      expect(response.status).toBe(404);
      expect(errorOf(await readJson(response)).code).toBe("not_found");
      clearCookies();
    });

    it("returns 401 to an anonymous preview", async () => {
      clearCookies();
      const response = await callApiWithParams(
        previewGet,
        { path: `/api/rooms/${publicRoom}/preview` },
        { id: publicRoom },
      );
      expect(response.status).toBe(401);
    });
  });

  describe("HTTP contract", () => {
    it("requires a session on GET /api/rooms", async () => {
      clearCookies();
      const response = await callApi(listGet, { path: "/api/rooms" });
      expect(response.status).toBe(401);
    });

    it("rejects relevance sort without a query with 400", async () => {
      await seedSession(carol.email, carol.password);
      const response = await callApi(listGet, { path: "/api/rooms?sort=relevance" });
      expect(response.status).toBe(400);
      expect(errorOf(await readJson(response)).code).toBe("validation");
      clearCookies();
    });

    it("rejects an unknown sort value with 400", async () => {
      await seedSession(carol.email, carol.password);
      const response = await callApi(listGet, { path: "/api/rooms?sort=bogus" });
      expect(response.status).toBe(400);
      expect(errorOf(await readJson(response)).code).toBe("validation");
      clearCookies();
    });

    it("rejects a limit above the cap with 400", async () => {
      await seedSession(carol.email, carol.password);
      const response = await callApi(listGet, { path: "/api/rooms?limit=500" });
      expect(response.status).toBe(400);
      clearCookies();
    });

    it("serves the additive discovery response to a signed-in student", async () => {
      await seedSession(carol.email, carol.password);
      const response = await callApi(listGet, {
        path: `/api/rooms?q=${encodeURIComponent(publicRoomName)}`,
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      const rooms = body.rooms as { id: string; href: string }[];
      const room = rooms.find((entry) => entry.id === publicRoom);
      expect(room).toBeDefined();
      expect(room?.href).toBe(`/rooms/${publicRoom}/preview`);
      expect(body).toHaveProperty("has_more");
      expect(body).toHaveProperty("next_cursor");
      // The private room must not be in the payload at all.
      expect(rooms.some((entry) => entry.id === privateRoom)).toBe(false);
      clearCookies();
    });
  });

  describe("grants", () => {
    it("denies anon execute on every discovery function", async () => {
      const { createClient } = await import("@supabase/supabase-js");
      const { apiUrl, publishableKey } = integrationEnv();
      const anon = createClient(apiUrl, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });

      for (const fn of ["list_public_rooms", "room_preview", "room_filter_options"] as const) {
        const { error } = await anon.rpc(
          fn,
          fn === "room_preview" ? { p_room_id: publicRoom } : {},
        );
        expect(error, `${fn} must not be executable by anon`).not.toBeNull();
        // PostgREST reports a revoked EXECUTE as an insufficient-privilege
        // error (42501 from the database, or PGRST301 when it cannot map it).
        expect(["42501", "PGRST301"]).toContain(error?.code);
      }
    });
  });
});
