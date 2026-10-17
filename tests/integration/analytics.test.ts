import { randomUUID } from "node:crypto";
import { GET as meCsvGet } from "@/app/api/analytics/me.csv/route";
import { GET as meGet } from "@/app/api/analytics/me/route";
import { GET as roomGet } from "@/app/api/analytics/rooms/[id]/route";
import { ANALYTICS_CSV_HEADER } from "@/lib/analytics/csv";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "./helpers/admin";
import { callApi, callApiWithParams, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import { integrationEnv } from "./helpers/env";
import { createUser, deleteUsers, type TestUser } from "./helpers/users";

/**
 * Study analytics (PR 16) end to end against the real local database: the
 * migrations' RPCs through their API routes, plus direct client calls for
 * the security properties routes cannot express (anon privileges, foreign
 * subject coercion, validation raises).
 *
 * The fixture is seeded with absolute UTC timestamps (never `now() - …`
 * inside SQL, so every expected number below is fixed): two focus sessions
 * — one deliberately crossing UTC midnight — goals, a quiz, card reviews,
 * uploads and an active plan. Expected values are computed from the same
 * UTC "today" the RPCs use; a run straddling exactly 00:00:00 UTC between
 * seed and assertion would shift the window (same hazard as every
 * date-sensitive suite; the risk window is a single millisecond).
 */

const DAY_MS = 86_400_000;

const ownerFocusYesterdayMinutes = 35; // 23:30 → 00:05, buckets on yesterday
const ownerFocusTodayMinutes = 50;
const ownerFocusTotal =
  ownerFocusYesterdayMinutes + ownerFocusTodayMinutes; // 85

const uploadBytes = 1000 + 2048; // two owner uploads today

type DayRow = {
  date: string;
  focus_minutes: number;
  goals_completed: number;
  quizzes_taken: number;
  cards_reviewed: number;
  uploads: number;
  quiz_correct: number;
  quiz_total: number;
};

type RoomDayRow = {
  date: string;
  focus_minutes: number;
  active_members: number;
  quiz_attempts: number;
};

type PersonalBody = {
  range: string;
  days: DayRow[];
  summary: Record<string, number | null | { difficulty: string; correct: number; total: number }[]>;
  plan: Record<string, number> | null;
};

function utcStartOfDay(offsetDays = 0, from: Date = new Date()): Date {
  const base = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
  );
  return new Date(base + offsetDays * DAY_MS);
}

function isoAt(day: Date, hour = 0, minute = 0): string {
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute),
  ).toISOString();
}

function iso(day: Date): string {
  return day.toISOString();
}

function numberSummary(body: PersonalBody, key: string): number {
  const value = body.summary[key];
  if (typeof value !== "number") {
    throw new Error(`summary.${key} was not a number: ${JSON.stringify(value)}`);
  }
  return value;
}

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;

const ROOM = randomUUID();
const QUIZ = randomUUID();
const DECK = randomUUID();
// Storage keys must satisfy study_resources_storage_path_layout:
// rooms/<room uuid>/<owner uuid>/<resource uuid>.<ext>.
const RESOURCE_A = randomUUID();
const RESOURCE_B = randomUUID();

const today = () => utcStartOfDay();

beforeAll(async () => {
  owner = await createUser("analytics-owner");
  member = await createUser("analytics-member");
  outsider = await createUser("analytics-outsider");

  const t0 = today();
  const yesterday = new Date(t0.getTime() - DAY_MS);
  // Crosses UTC midnight: starts 23:30 yesterday, ends 00:05 today, and
  // must bucket on the start day — the timezone note's exact claim.
  const crossStart = new Date(yesterday.getTime() + (23 * 60 + 30) * 60_000);
  const crossEnd = new Date(crossStart.getTime() + ownerFocusYesterdayMinutes * 60_000);
  const todayStart = new Date(t0.getTime() + 60 * 60_000);
  const todayEnd = new Date(todayStart.getTime() + ownerFocusTodayMinutes * 60_000);

  psql(`
    insert into public.rooms (id, owner_id, name, capacity)
    values ('${ROOM}', '${owner.id}', 'Analytics room', 4);

    insert into public.room_members (room_id, user_id, role) values
      ('${ROOM}', '${owner.id}', 'owner'),
      ('${ROOM}', '${member.id}', 'student');

    insert into public.focus_sessions
      (room_id, state, duration_seconds, started_at, ends_at, ended_at, paused_seconds)
    values
      ('${ROOM}', 'completed', ${ownerFocusYesterdayMinutes * 60},
       '${crossStart.toISOString()}', '${crossEnd.toISOString()}', '${crossEnd.toISOString()}', 0),
      ('${ROOM}', 'completed', ${ownerFocusTodayMinutes * 60},
       '${todayStart.toISOString()}', '${todayEnd.toISOString()}', '${todayEnd.toISOString()}', 0);

    insert into public.study_goals
      (id, user_id, room_id, title, status, completed_at, created_at)
    values
      (gen_random_uuid(), '${owner.id}', '${ROOM}', 'Owner goal (done today)',
       'completed', '${isoAt(t0, 12, 0)}', '${isoAt(new Date(t0.getTime() - 3 * DAY_MS), 9, 0)}'),
      (gen_random_uuid(), '${owner.id}', '${ROOM}', 'Owner goal (open)',
       'active', null, '${isoAt(t0, 8, 0)}'),
      (gen_random_uuid(), '${member.id}', '${ROOM}', 'Member goal (done yesterday)',
       'completed', '${isoAt(yesterday, 18, 0)}', '${isoAt(new Date(t0.getTime() - 5 * DAY_MS), 9, 0)}');

    insert into public.study_artifacts
      (id, room_id, creator_id, kind, difficulty, question_count, card_count, status, payload, completed_at)
    values
      ('${QUIZ}', '${ROOM}', '${owner.id}', 'quiz', 'hard', 5, null, 'ready', '{}'::jsonb,
       '${isoAt(new Date(t0.getTime() - 2 * DAY_MS), 10, 0)}'),
      ('${DECK}', '${ROOM}', '${owner.id}', 'deck', 'easy', null, 10, 'ready', '{}'::jsonb,
       '${isoAt(new Date(t0.getTime() - 2 * DAY_MS), 10, 0)}');

    insert into public.quiz_attempts (artifact_id, user_id, score, total, created_at) values
      ('${QUIZ}', '${owner.id}', 3, 5, '${isoAt(t0, 11, 0)}'),
      ('${QUIZ}', '${member.id}', 5, 5, '${isoAt(yesterday, 11, 0)}');

    insert into public.flashcard_reviews
      (artifact_id, user_id, card_ordinal, grade, streak, ease, interval_days,
       last_reviewed_at, next_review_at)
    values
      ('${DECK}', '${owner.id}', 0, 'got_it', 1, 2.5, 3,
       '${isoAt(new Date(t0.getTime() - 2 * DAY_MS), 17, 0)}',
       '${isoAt(new Date(t0.getTime() + 3 * DAY_MS), 17, 0)}'),
      ('${DECK}', '${member.id}', 0, 'again', 0, 2.5, 0,
       '${isoAt(yesterday, 17, 0)}', '${isoAt(yesterday, 17, 0)}');

    insert into public.study_resources
      (owner_id, room_id, storage_path, title, original_filename, content_type, size_bytes, created_at)
    values
      ('${owner.id}', '${ROOM}', 'rooms/${ROOM}/${owner.id}/${RESOURCE_A}.txt', 'Note A', 'a.txt', 'text/plain', 1000, '${isoAt(t0, 9, 0)}'),
      ('${owner.id}', '${ROOM}', 'rooms/${ROOM}/${owner.id}/${RESOURCE_B}.txt', 'Note B', 'b.txt', 'text/plain', 2048, '${isoAt(t0, 10, 0)}');

    insert into public.study_plans (id, user_id, status, exam_date, hours_per_day, generated_at)
    values (gen_random_uuid(), '${owner.id}', 'active', '${isoAt(new Date(t0.getTime() + 21 * DAY_MS)).slice(0, 10)}', 2, '${iso(t0)}');

    insert into public.plan_items
      (plan_id, ordinal, item_date, task, kind, estimated_minutes, done_at)
    select sp.id, 0, '${isoAt(t0).slice(0, 10)}', 'Planned today', 'read', 60, '${isoAt(t0, 14, 0)}'
      from public.study_plans sp where sp.user_id = '${owner.id}' and sp.status = 'active';

    insert into public.plan_items
      (plan_id, ordinal, item_date, task, kind, estimated_minutes, done_at)
    select sp.id, 1, '${isoAt(new Date(t0.getTime() + DAY_MS)).slice(0, 10)}', 'Planned tomorrow', 'practice', 45, null
      from public.study_plans sp where sp.user_id = '${owner.id}' and sp.status = 'active';
  `);
});

afterAll(async () => {
  clearCookies();
  await deleteUsers([owner, member, outsider]);
});

function meRequest(query: string) {
  return callApi(meGet, { path: `/api/analytics/me${query}` });
}

describe("grant surface", () => {
  it("exposes both functions to authenticated and to nobody else", () => {
    expect(
      psql(
        "select has_function_privilege('authenticated', 'public.analytics_me(uuid,integer)', 'execute');",
      ),
    ).toBe("t");
    expect(
      psql(
        "select has_function_privilege('authenticated', 'public.analytics_room(uuid,integer)', 'execute');",
      ),
    ).toBe("t");
    expect(
      psql("select has_function_privilege('anon', 'public.analytics_me(uuid,integer)', 'execute');"),
    ).toBe("f");
    expect(
      psql(
        "select has_function_privilege('anon', 'public.analytics_room(uuid,integer)', 'execute');",
      ),
    ).toBe("f");
  });
});

describe("GET /api/analytics/me", () => {
  it("requires a session", async () => {
    clearCookies();
    const response = await meRequest("?range=7d");
    expect(response.status).toBe(401);
    expect(errorOf(await readJson(response)).code).toBe("unauthenticated");
  });

  it("rejects a missing or unknown range with validation", async () => {
    await seedSession(owner.email, owner.password);

    const missing = await meRequest("");
    expect(missing.status).toBe(400);
    const missingError = errorOf(await readJson(missing));
    expect(missingError.code).toBe("validation");
    expect(missingError.issues?.[0]?.path).toBe("range");

    const unknown = await meRequest("?range=1y");
    expect(unknown.status).toBe(400);
    expect(errorOf(await readJson(unknown)).code).toBe("validation");
  });

  it("serves the owner's fixed fixture with the summary equal to the day buckets", async () => {
    await seedSession(owner.email, owner.password);
    const response = await meRequest("?range=7d");
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as PersonalBody;

    expect(Object.keys(body).sort()).toEqual(["days", "plan", "range", "summary"]);
    expect(body.range).toBe("7d");
    expect(body.days).toHaveLength(7);

    const t0 = today();
    expect(body.days[0]?.date).toBe(utcStartOfDay(-6, t0).toISOString().slice(0, 10));
    expect(body.days[6]?.date).toBe(t0.toISOString().slice(0, 10));

    const yesterdayRow = body.days[5];
    const twoDaysAgoRow = body.days[4];
    const todayRow = body.days[6];

    // Cross-midnight session buckets on its START day, not on its end day.
    expect(yesterdayRow?.focus_minutes).toBe(ownerFocusYesterdayMinutes);
    expect(todayRow?.focus_minutes).toBe(ownerFocusTodayMinutes);
    expect(twoDaysAgoRow?.cards_reviewed).toBe(1);
    expect(todayRow?.goals_completed).toBe(1);
    expect(todayRow?.quizzes_taken).toBe(1);
    expect(todayRow?.uploads).toBe(2);
    expect(todayRow?.quiz_correct).toBe(3);
    expect(todayRow?.quiz_total).toBe(5);

    const daySum = (key: keyof DayRow) =>
      body.days.reduce((sum, day) => sum + (day[key] as number), 0);
    expect(numberSummary(body, "focus_minutes")).toBe(ownerFocusTotal);
    expect(numberSummary(body, "focus_minutes")).toBe(daySum("focus_minutes"));
    expect(numberSummary(body, "goals_completed")).toBe(daySum("goals_completed"));
    expect(numberSummary(body, "quiz_correct")).toBe(daySum("quiz_correct"));
    expect(numberSummary(body, "quiz_total")).toBe(daySum("quiz_total"));
    expect(numberSummary(body, "uploads")).toBe(daySum("uploads"));

    expect(numberSummary(body, "goals_created")).toBe(2);
    expect(numberSummary(body, "goals_active")).toBe(1);
    expect(numberSummary(body, "quiz_correct")).toBe(3);
    expect(numberSummary(body, "quiz_total")).toBe(5);
    expect(body.summary.accuracy).toBe(0.6);
    expect(body.summary.quiz_by_difficulty).toEqual([
      { difficulty: "hard", correct: 3, total: 5 },
    ]);
    expect(numberSummary(body, "cards_due")).toBe(9);
    expect(numberSummary(body, "upload_bytes")).toBe(uploadBytes);
    expect(numberSummary(body, "sessions")).toBe(2);
    expect(numberSummary(body, "avg_session_minutes")).toBe(43);
    expect(numberSummary(body, "previous_focus_minutes")).toBe(0);
    expect(numberSummary(body, "study_days")).toBe(2);
    expect(numberSummary(body, "current_streak_days")).toBe(2);
    expect(numberSummary(body, "longest_streak_days")).toBe(2);

    // Window-scoped plan: tomorrow's item is outside today's window.
    expect(body.plan).toEqual({
      planned_minutes: 60,
      items_total: 1,
      items_done: 1,
      items_overdue: 0,
    });
  });

  it("expands 90d to ninety zero-filled rows ending today", async () => {
    await seedSession(owner.email, owner.password);
    const body = (await readJson(await meRequest("?range=90d"))) as PersonalBody;
    expect(body.days).toHaveLength(90);
    expect(body.days[89]?.date).toBe(today().toISOString().slice(0, 10));
    expect(numberSummary(body, "focus_minutes")).toBe(ownerFocusTotal);
  });

  it("ignores ?user_id= — the session is always the subject", async () => {
    await seedSession(owner.email, owner.password);
    const own = (await readJson(await meRequest("?range=7d"))) as PersonalBody;
    const spoofed = (await readJson(
      await meRequest(`?range=7d&user_id=${member.id}`),
    )) as PersonalBody;
    expect(spoofed).toEqual(own);
    expect(numberSummary(spoofed, "focus_minutes")).toBe(ownerFocusTotal);
  });

  it("gives a fresh account an all-zero range with null accuracy and no plan", async () => {
    await seedSession(outsider.email, outsider.password);
    const body = (await readJson(await meRequest("?range=7d"))) as PersonalBody;

    expect(body.days).toHaveLength(7);
    for (const day of body.days) {
      expect(day).toMatchObject({
        focus_minutes: 0,
        goals_completed: 0,
        quizzes_taken: 0,
        cards_reviewed: 0,
        uploads: 0,
      });
    }
    expect(numberSummary(body, "focus_minutes")).toBe(0);
    expect(body.summary.accuracy).toBeNull();
    expect(body.summary.quiz_by_difficulty).toEqual([]);
    expect(numberSummary(body, "cards_due")).toBe(0);
    expect(numberSummary(body, "study_days")).toBe(0);
    expect(numberSummary(body, "current_streak_days")).toBe(0);
    expect(numberSummary(body, "longest_streak_days")).toBe(0);
    expect(numberSummary(body, "sessions")).toBe(0);
    expect(body.plan).toBeNull();
  });
});

describe("CSV export", () => {
  it("matches the JSON days row-for-row and carries the spec's columns", async () => {
    await seedSession(owner.email, owner.password);
    const json = (await readJson(await meRequest("?range=7d"))) as PersonalBody;
    const csvResponse = await meRequest("?range=7d&format=csv");
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get("content-type")).toContain("text/csv");

    const lines = (await csvResponse.text()).trim().split("\n");
    expect(lines[0]).toBe(ANALYTICS_CSV_HEADER);
    expect(lines).toHaveLength(json.days.length + 1);

    lines.slice(1).forEach((line, index) => {
      const [date, focus, goals, quizzes, cards, uploads] = line.split(",");
      const day = json.days[index];
      expect(date).toBe(day?.date);
      expect(Number(focus)).toBe(day?.focus_minutes);
      expect(Number(goals)).toBe(day?.goals_completed);
      expect(Number(quizzes)).toBe(day?.quizzes_taken);
      expect(Number(cards)).toBe(day?.cards_reviewed);
      expect(Number(uploads)).toBe(day?.uploads);
    });
  });

  it("serves /me.csv as the same file with a download filename", async () => {
    await seedSession(owner.email, owner.password);
    const viaParam = await meRequest("?range=30d&format=csv");
    const viaPath = await callApi(meCsvGet, { path: "/api/analytics/me.csv?range=30d" });
    expect(viaPath.status).toBe(200);
    expect(viaPath.headers.get("content-disposition")).toContain(
      'filename="study-analytics-30d.csv"',
    );
    const pathText = await viaPath.text();
    const paramText = await viaParam.text();
    expect(pathText).toBe(paramText);
    expect(pathText.trim().split("\n")).toHaveLength(31);
  });

  it("still demands a range on the download path", async () => {
    await seedSession(owner.email, owner.password);
    const response = await callApi(meCsvGet, { path: "/api/analytics/me.csv" });
    expect(response.status).toBe(400);
    expect(errorOf(await readJson(response)).code).toBe("validation");
  });
});

describe("GET /api/analytics/rooms/[id]", () => {
  const roomRequest = (query: string, roomId: string = ROOM) =>
    callApiWithParams(
      roomGet,
      { path: `/api/analytics/rooms/${roomId}${query}` },
      { id: roomId },
    );

  it("requires a session", async () => {
    clearCookies();
    const response = await roomRequest("?range=7d");
    expect(response.status).toBe(401);
    expect(errorOf(await readJson(response)).code).toBe("unauthenticated");
  });

  it("rejects a missing range and a non-UUID room id", async () => {
    await seedSession(owner.email, owner.password);
    const noRange = await roomRequest("");
    expect(noRange.status).toBe(400);

    const badId = await roomRequest("?range=7d", "not-a-uuid");
    expect(badId.status).toBe(400);
    expect(errorOf(await readJson(badId)).issues?.[0]?.path).toBe("roomId");
  });

  it("serves the owner counts-only payload with no member-identifying field", async () => {
    await seedSession(owner.email, owner.password);
    const response = await roomRequest("?range=7d");
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as {
      range: string;
      summary: Record<string, number>;
      days: RoomDayRow[];
    };

    expect(Object.keys(body).sort()).toEqual(["days", "range", "summary"]);
    expect(body.summary).toEqual({
      focus_minutes_total: ownerFocusTotal,
      active_members: 2,
      goals_created: 3,
      goals_completed: 2,
      quiz_attempts: 2,
      quiz_correct: 8,
      quiz_total: 10,
      uploads: 2,
    });
    expect(body.days).toHaveLength(7);
    expect(body.days[5]).toMatchObject({
      focus_minutes: ownerFocusYesterdayMinutes,
      active_members: 2,
      quiz_attempts: 1,
    });
    expect(body.days[6]).toMatchObject({
      focus_minutes: ownerFocusTodayMinutes,
      active_members: 1,
      quiz_attempts: 1,
    });

    const flat = JSON.stringify(body).toLowerCase();
    expect(flat).not.toContain(owner.id);
    expect(flat).not.toContain(member.id);
    expect(flat).not.toContain("@");
    expect(flat).not.toContain("alias");
    expect(flat).not.toContain("user_id");
  });

  it("answers member, outsider and missing room with the identical 404", async () => {
    const codes: string[] = [];

    await seedSession(member.email, member.password);
    const asMember = await roomRequest("?range=7d");
    expect(asMember.status).toBe(404);
    codes.push(errorOf(await readJson(asMember)).code);

    await seedSession(outsider.email, outsider.password);
    const asOutsider = await roomRequest("?range=7d");
    expect(asOutsider.status).toBe(404);
    codes.push(errorOf(await readJson(asOutsider)).code);

    await seedSession(owner.email, owner.password);
    const missing = randomUUID();
    const asOwner = await roomRequest("?range=7d", missing);
    expect(asOwner.status).toBe(404);
    codes.push(errorOf(await readJson(asOwner)).code);

    expect(codes).toEqual(["not_found", "not_found", "not_found"]);
  });

  it("opens for a member only while the moderators row exists", async () => {
    psql(
      `insert into public.room_moderators (room_id, user_id, granted_by) values ('${ROOM}', '${member.id}', '${owner.id}');`,
    );
    try {
      await seedSession(member.email, member.password);
      const allowed = await roomRequest("?range=7d");
      expect(allowed.status).toBe(200);
      const body = (await readJson(allowed)) as { summary: { focus_minutes_total: number } };
      expect(body.summary.focus_minutes_total).toBe(ownerFocusTotal);
    } finally {
      psql(`delete from public.room_moderators where room_id = '${ROOM}' and user_id = '${member.id}';`);
    }

    await seedSession(member.email, member.password);
    const revoked = await roomRequest("?range=7d");
    expect(revoked.status).toBe(404);
    expect(errorOf(await readJson(revoked)).code).toBe("not_found");
  });
});

describe("analytics RPC contract (direct client calls)", () => {
  it("collapses a foreign p_user_id to the caller's own numbers", async () => {
    const { data: ownData, error: ownError } = await owner.client.rpc("analytics_me", {
      p_user_id: owner.id,
      p_days: 7,
    });
    expect(ownError).toBeNull();
    const ownFocus = (ownData as { summary: { focus_minutes: number } }).summary
      .focus_minutes;
    expect(ownFocus).toBe(ownerFocusTotal);

    const { data: foreignData, error: foreignError } = await owner.client.rpc(
      "analytics_me",
      { p_user_id: member.id, p_days: 7 },
    );
    expect(foreignError).toBeNull();
    expect((foreignData as { summary: { focus_minutes: number } }).summary.focus_minutes).toBe(
      ownFocus,
    );

    // …and the member's own call sees only their own (zero) focus time.
    const { data: memberData, error: memberError } = await member.client.rpc(
      "analytics_me",
      { p_user_id: member.id, p_days: 7 },
    );
    expect(memberError).toBeNull();
    expect((memberData as { summary: { focus_minutes: number } }).summary.focus_minutes).toBe(0);
    expect(
      (memberData as { summary: { accuracy: number | null } }).summary.accuracy,
    ).toBe(1);
  });

  it("refuses anon execution and out-of-range day counts", async () => {
    const { apiUrl, publishableKey } = integrationEnv();
    const anon = createClient(apiUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    const anonAttempt = await anon.rpc("analytics_me", {
      p_user_id: owner.id,
      p_days: 7,
    });
    expect(anonAttempt.error?.message ?? "").toMatch(/permission denied/i);

    for (const days of [0, 999]) {
      const attempt = await owner.client.rpc("analytics_me", {
        p_user_id: owner.id,
        p_days: days,
      });
      expect(attempt.error?.message ?? "").toContain("validation");
    }
  });

  it("raises not_found from analytics_room for members and strangers alike", async () => {
    for (const user of [member, outsider]) {
      const attempt = await user.client.rpc("analytics_room", {
        p_room_id: ROOM,
        p_days: 7,
      });
      expect(attempt.error?.message ?? "").toContain("not_found");
    }

    const { data, error } = await owner.client.rpc("analytics_room", {
      p_room_id: ROOM,
      p_days: 7,
    });
    expect(error).toBeNull();
    expect((data as { summary: { focus_minutes_total: number } }).summary.focus_minutes_total).toBe(
      ownerFocusTotal,
    );
  });

  it("carries no user identifier in either payload", async () => {
    const { data: roomData } = await owner.client.rpc("analytics_room", {
      p_room_id: ROOM,
      p_days: 7,
    });
    const { data: meData } = await owner.client.rpc("analytics_me", {
      p_user_id: owner.id,
      p_days: 7,
    });
    expect(JSON.stringify(roomData)).not.toContain(owner.id);
    expect(JSON.stringify(roomData)).not.toContain(member.id);
    expect(JSON.stringify(meData)).not.toContain(owner.id);
  });
});
