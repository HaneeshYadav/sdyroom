import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as profileGet, PATCH as profilePatch } from "@/app/api/profile/route";
import { PATCH as prefsPatch } from "@/app/api/profile/notification-prefs/route";
import { POST as invitationsPost } from "@/app/api/rooms/[id]/invitations/route";
import { POST as joinPost } from "@/app/api/rooms/[id]/join/route";
import { GET as membersGet } from "@/app/api/rooms/[id]/members/route";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { createRoomSchema } from "@/lib/validation/rooms";
import { callApi, callApiWithParams, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import { psql } from "./helpers/admin";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

/**
 * PR 20 end to end: the settings read/write contract (shape, strict bodies,
 * vocabulary, rate limit), the database floor underneath it (column grants —
 * no `email`/`user_id` column exists and `created_at`/`id` are not updatable,
 * probed through PostgREST exactly as a hostile student would reach it),
 * cross-user isolation, the roster reflection the alias change promises, and
 * the single-source-of-truth check that a `none` preference really does stop
 * PR 11's writer at the source. SQL reads only count rows the API must not
 * see — never to grant or bypass authorization.
 */
describe("profile and settings", () => {
  let alice: TestUser;
  let bob: TestUser;
  let newbie: TestUser;
  let prefsUser: TestUser;
  let limiter: TestUser;

  let aliceAlias: string;
  let bobAlias: string;
  let prefsAlias: string;
  /** Joinable directly (roster test): invites to a public room are 409. */
  let publicRoomId: string;
  /** Private: the invitation route only fires for private rooms. */
  let privateRoomId: string;

  beforeAll(async () => {
    [alice, bob, newbie, prefsUser, limiter] = await Promise.all([
      createUser("set-alice"),
      createUser("set-bob"),
      createUser("set-newbie"),
      createUser("set-prefs"),
      createUser("set-limiter"),
    ]);

    aliceAlias = uniqueAlias("stalice");
    bobAlias = uniqueAlias("stbob");
    prefsAlias = uniqueAlias("stpref");

    await Promise.all([
      createProfile(alice.client, alice.id, aliceAlias),
      createProfile(bob.client, bob.id, bobAlias),
      createProfile(prefsUser.client, prefsUser.id, prefsAlias),
      createProfile(limiter.client, limiter.id, uniqueAlias("stlimit")),
    ]);

    const [publicRoom, privateRoom] = await Promise.all([
      createRoom(
        alice.client,
        createRoomSchema.parse({
          name: uniqueName("Settings Room"),
          exam_track: "JEE",
          subject: "Physics",
          language: "English",
          capacity: 4,
          visibility: "public",
        }),
      ),
      createRoom(
        alice.client,
        createRoomSchema.parse({
          name: uniqueName("Settings Private Room"),
          exam_track: "NEET",
          subject: "Biology",
          language: "English",
          capacity: 4,
          visibility: "private",
        }),
      ),
    ]);
    publicRoomId = publicRoom.id;
    privateRoomId = privateRoom.id;
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([alice, bob, newbie, prefsUser, limiter]);
  });

  async function as(user: TestUser): Promise<void> {
    await seedSession(user.email, user.password);
  }

  function get() {
    return callApi(profileGet, { path: "/api/profile" });
  }

  function patch(body: unknown) {
    return callApi(profilePatch, {
      path: "/api/profile",
      method: "PATCH",
      body,
    });
  }

  async function profileOf(user: TestUser): Promise<Record<string, unknown>> {
    await as(user);
    const response = await get();
    expect(response.status).toBe(200);
    const body = await readJson(response);
    return body.profile as Record<string, unknown>;
  }

  it("answers 401 for a signed-out caller", async () => {
    clearCookies();

    const read = await get();
    expect(read.status).toBe(401);
    expect(errorOf(await readJson(read)).code).toBe("unauthenticated");

    const write = await patch({ alias: "AnyoneHome" });
    expect(write.status).toBe(401);
    expect(errorOf(await readJson(write)).code).toBe("unauthenticated");
  });

  it("answers 404 not_found for a session that never onboarded", async () => {
    await as(newbie);

    const read = await get();
    expect(read.status).toBe(404);
    expect(errorOf(await readJson(read)).code).toBe("not_found");

    // The absent-row path on write: no defaults-insert is possible because
    // alias is NOT NULL — the same 404, whatever the body asks for.
    const write = await patch({ language: "English" });
    expect(write.status).toBe(404);
    expect(errorOf(await readJson(write)).code).toBe("not_found");
  });

  it("returns exactly the documented profile shape for an onboarded student", async () => {
    await as(alice);

    const response = await get();
    expect(response.status).toBe(200);
    const body = await readJson(response);
    const profile = body.profile as Record<string, unknown>;

    expect(Object.keys(profile).sort()).toEqual([
      "alias",
      "created_at",
      "email",
      "exam_targets",
      "language",
      "notification_prefs",
    ]);
    expect(profile.alias).toBe(aliceAlias);
    expect(profile.exam_targets).toEqual([]);
    expect(profile.language).toBeNull();
    expect(profile.email).toBe(alice.email);
    expect(profile.notification_prefs).toEqual({
      default: "all",
      invite: "all",
      moderation: "all",
      ai: "all",
      resource: "all",
    });
    expect(typeof profile.created_at).toBe("string");
    // Identity rides the session, never the body.
    expect(JSON.stringify(body)).not.toContain(alice.id);
  });

  it("updates alias, exam targets and language together and reads them back", async () => {
    const nextAlias = uniqueAlias("stnew");
    const before = await profileOf(alice);

    const response = await patch({
      alias: nextAlias,
      exam_targets: ["NEET", "JEE"],
      language: "Hinglish",
    });

    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.profile).toMatchObject({
      alias: nextAlias,
      exam_targets: ["NEET", "JEE"],
      language: "Hinglish",
      email: alice.email,
      created_at: before.created_at,
    });

    const after = await profileOf(alice);
    expect(after).toEqual(body.profile);
  });

  it("rejects a hostile body with 400 and leaves every field untouched", async () => {
    const snapshot = await profileOf(alice);

    const response = await patch({
      alias: uniqueAlias("stsneak"),
      email: "attacker@example.com",
      user_id: bob.id,
      id: bob.id,
      created_at: "2020-01-01T00:00:00Z",
      updated_at: "2020-01-01T00:00:00Z",
    });

    expect(response.status).toBe(400);
    const error = errorOf(await readJson(response));
    expect(error.code).toBe("validation");
    expect(error.issues?.length).toBeGreaterThan(0);

    expect(await profileOf(alice)).toEqual(snapshot);
  });

  it("rejects an empty body with 400 invalid_request", async () => {
    const response = await patch({});

    expect(response.status).toBe(400);
    expect(errorOf(await readJson(response)).code).toBe("invalid_request");
  });

  it("enforces the vocabulary server-side and never partially applies", async () => {
    const snapshot = await profileOf(alice);

    for (const payload of [
      { exam_targets: ["anything"] },
      { exam_targets: ["NEET", "JEE", "UPSC", "SSC"] },
      { language: "Klingon" },
    ]) {
      const response = await patch(payload);
      expect(response.status).toBe(400);
      expect(errorOf(await readJson(response)).code).toBe("validation");
    }

    expect(await profileOf(alice)).toEqual(snapshot);
  });

  it("keeps a second student's row untouched by the first student's saves", async () => {
    const aliceSnapshot = await profileOf(alice);

    await as(bob);
    const bobAlias2 = uniqueAlias("stbob2");
    const bobWrite = await patch({ alias: bobAlias2 });
    expect(bobWrite.status).toBe(200);

    const bobProfile = await profileOf(bob);
    expect(bobProfile.alias).toBe(bobAlias2);
    expect(bobProfile.exam_targets).toEqual([]);

    expect(await profileOf(alice)).toEqual(aliceSnapshot);
  });

  it("holds the database floor: no email/user_id column, created_at and id not updatable", async () => {
    const snapshot = await profileOf(bob);

    // Probed exactly as a hostile student would — the normal publishable-key
    // client bound to their own session, straight at PostgREST, bypassing the
    // app's routes entirely.
    const created = await alice.client
      .from("profiles")
      .update({ created_at: "2020-01-01T00:00:00Z" })
      .eq("id", alice.id);
    expect(created.error).toBeTruthy();
    expect(created.error?.code).toBe("42501");

    const idSwap = await alice.client
      .from("profiles")
      .update({ id: bob.id })
      .eq("id", alice.id);
    expect(idSwap.error).toBeTruthy();
    expect(idSwap.error?.code).toBe("42501");

    const email = await alice.client
      .from("profiles")
      .update({ email: "attacker@example.com" })
      .eq("id", alice.id);
    expect(email.error).toBeTruthy();

    const userId = await alice.client
      .from("profiles")
      .update({ user_id: bob.id })
      .eq("id", alice.id);
    expect(userId.error).toBeTruthy();

    // None of the probes wrote anything: the API read is byte-identical.
    expect(await profileOf(bob)).toEqual(snapshot);
  });

  it("reflects an alias change in a room-mate's roster read path", async () => {
    const before = await profileOf(alice);
    const oldAlias = String(before.alias);

    await as(bob);
    const join = await callApiWithParams(
      joinPost,
      { path: `/api/rooms/${publicRoomId}/join`, method: "POST", body: {} },
      { id: publicRoomId },
    );
    expect([200, 201]).toContain(join.status);

    const rosterBefore = await readJson(
      await callApiWithParams(
        membersGet,
        { path: `/api/rooms/${publicRoomId}/members` },
        { id: publicRoomId },
      ),
    );
    const membersBefore = rosterBefore.members as { alias: string }[];
    expect(membersBefore.some((m) => m.alias === oldAlias)).toBe(true);

    const newAlias = uniqueAlias("stross");
    await as(alice);
    const changed = await patch({ alias: newAlias });
    expect(changed.status).toBe(200);

    await as(bob);
    const rosterAfter = await readJson(
      await callApiWithParams(
        membersGet,
        { path: `/api/rooms/${publicRoomId}/members` },
        { id: publicRoomId },
      ),
    );
    const membersAfter = rosterAfter.members as { alias: string }[];
    expect(membersAfter.some((m) => m.alias === newAlias)).toBe(true);
    expect(membersAfter.some((m) => m.alias === oldAlias)).toBe(false);
  });

  it("keeps one source of truth for notification prefs, and 'none' stops the writer", async () => {
    // Set through PR 11's endpoint (settings consumes it — no second writer).
    await as(prefsUser);
    const setNone = await callApi(prefsPatch, {
      path: "/api/profile/notification-prefs",
      method: "PATCH",
      body: { prefs: { invite: "none" } },
    });
    expect(setNone.status).toBe(200);

    // The settings read model shows the same value — one column, one truth.
    const prefsProfile = await profileOf(prefsUser);
    expect(
      (prefsProfile.notification_prefs as Record<string, string>).invite,
    ).toBe("none");

    // A real producer (the invitation route) must create no row for them.
    await as(alice);
    const invite = await callApiWithParams(
      invitationsPost,
      {
        path: `/api/rooms/${privateRoomId}/invitations`,
        method: "POST",
        body: { invitee_alias: prefsAlias },
      },
      { id: privateRoomId },
    );
    expect(invite.status).toBe(201);

    const rows = Number(
      psql(
        `select count(*) from public.notifications where user_id = '${prefsUser.id}';`,
      ),
    );
    expect(rows).toBe(0);
  });

  it("answers 429 rate_limited once profile:{userId} is spent", async () => {
    await as(limiter);

    let limited: Response | null = null;
    let saves = 0;
    for (let attempt = 0; attempt < 35 && limited === null; attempt += 1) {
      const response = await patch({ language: null });
      if (response.status === 429) {
        limited = response;
      } else {
        expect(response.status).toBe(200);
        saves += 1;
      }
    }

    expect(limited).not.toBeNull();
    expect(saves).toBe(30);
    const error = errorOf(await readJson(limited as Response));
    expect(error.code).toBe("rate_limited");
    expect((limited as Response).headers.get("Retry-After")).toBe("60");
  });
});
