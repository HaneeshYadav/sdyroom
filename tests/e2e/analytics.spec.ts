import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { psql } from "../integration/helpers/admin";
import { createRoomViaUi, enterRoomViaUi, joinRoomViaUi, searchRooms } from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";

/**
 * PR 16 through the real interface: the personal dashboard (empty state
 * first, then a deterministically seeded fixture with the exact numbers the
 * strip, charts, ring and plan block must show), the range switch with its
 * URL and table growth, the CSV download, the visible UTC note, and the
 * room-analytics access rules — owner (and appointed moderator) only, with
 * the identical 404 for a plain member, a stranger and a missing room.
 *
 * Seeding is admin SQL with absolute UTC timestamps (never `now() - …`), the
 * same fixture discipline as tests/integration/analytics.test.ts, so every
 * expected number below is fixed. A run that straddles exactly 00:00:00 UTC
 * between seed and assertion would shift the window (the same hazard every
 * date-sensitive suite carries).
 */

const DAY_MS = 86_400_000;

function utcStartOfDay(offsetDays = 0): Date {
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + offsetDays * DAY_MS);
}

function isoAt(day: Date, hour = 0, minute = 0): string {
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute),
  ).toISOString();
}

function userIdByEmail(email: string): string {
  const id = psql(`select id from auth.users where email = '${email}';`).trim();
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    throw new Error(`No user id for ${email}: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * The fixed fixture: a cross-midnight focus session (23:30 → 00:05, buckets
 * on yesterday), a session today, one goal created and completed today, a
 * 4/5 quiz attempt today, a never-reviewed 10-card deck, and an active plan
 * whose done item is due today (tomorrow's stays outside the window).
 */
async function seedAnalyticsFixture(roomId: string, ownerId: string): Promise<void> {
  const t0 = utcStartOfDay();
  const yesterday = new Date(t0.getTime() - DAY_MS);
  const crossStart = new Date(yesterday.getTime() + (23 * 60 + 30) * 60_000);
  const crossEnd = new Date(crossStart.getTime() + 35 * 60_000);
  const todayStart = new Date(t0.getTime() + 60 * 60_000);
  const todayEnd = new Date(todayStart.getTime() + 50 * 60_000);
  const quiz = randomUUID();
  const deck = randomUUID();

  psql(`
    insert into public.focus_sessions
      (room_id, state, duration_seconds, started_at, ends_at, ended_at, paused_seconds)
    values
      ('${roomId}', 'completed', 2100,
       '${crossStart.toISOString()}', '${crossEnd.toISOString()}', '${crossEnd.toISOString()}', 0),
      ('${roomId}', 'completed', 3000,
       '${todayStart.toISOString()}', '${todayEnd.toISOString()}', '${todayEnd.toISOString()}', 0);

    insert into public.study_goals
      (user_id, room_id, title, status, completed_at, created_at)
    values
      ('${ownerId}', '${roomId}', 'Seeded goal', 'completed',
       '${isoAt(t0, 12, 0)}', '${isoAt(t0, 9, 0)}');

    insert into public.study_artifacts
      (id, room_id, creator_id, kind, difficulty, question_count, card_count, status, payload, completed_at)
    values
      ('${quiz}', '${roomId}', '${ownerId}', 'quiz', 'hard', 5, null, 'ready', '{}'::jsonb, '${isoAt(t0, 8, 0)}'),
      ('${deck}', '${roomId}', '${ownerId}', 'deck', 'easy', null, 10, 'ready', '{}'::jsonb, '${isoAt(t0, 8, 0)}');

    insert into public.quiz_attempts (artifact_id, user_id, score, total, created_at)
    values ('${quiz}', '${ownerId}', 4, 5, '${isoAt(t0, 11, 0)}');

    insert into public.study_plans (user_id, status, exam_date, hours_per_day, generated_at)
    values ('${ownerId}', 'active', '${isoAt(new Date(t0.getTime() + 21 * DAY_MS)).slice(0, 10)}', 2, '${isoAt(t0)}');

    insert into public.plan_items
      (plan_id, ordinal, item_date, task, kind, estimated_minutes, done_at)
    select sp.id, 0, '${isoAt(t0).slice(0, 10)}', 'Planned today', 'read', 60, '${isoAt(t0, 14, 0)}'
      from public.study_plans sp where sp.user_id = '${ownerId}' and sp.status = 'active';

    insert into public.plan_items
      (plan_id, ordinal, item_date, task, kind, estimated_minutes, done_at)
    select sp.id, 1, '${isoAt(new Date(t0.getTime() + DAY_MS)).slice(0, 10)}', 'Planned tomorrow', 'practice', 45, null
      from public.study_plans sp where sp.user_id = '${ownerId}' and sp.status = 'active';
  `);
}

test("the dashboard starts honestly empty, then shows the seeded fixture, range switch and CSV", async ({
  page,
}) => {
  const user = await signUpAndOnboard(page, "analytics-dash");

  // Session-gated nav link (absent for signed-out visitors, covered by the
  // link's own unit tests); here it is the entry point.
  const analyticsNav = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Analytics" });
  await expect(analyticsNav).toBeVisible();
  await analyticsNav.click();
  await page.waitForURL(/\/analytics$/);
  await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();

  // --- Empty state: honest zeros, never invented activity. ---
  await expect(
    page.getByText("No study activity in this range yet"),
  ).toBeVisible();
  const strip = page.getByRole("region", { name: "Range summary" });
  await expect(strip.getByText("0 min", { exact: true })).toBeVisible();
  await expect(strip.getByText("—")).toHaveCount(1); // accuracy with no attempts
  // Two honest zeros: goals completed and cards due.
  await expect(strip.getByText("0", { exact: true })).toHaveCount(2);
  await expect(
    page.getByText("No focus sessions in this range yet."),
  ).toBeVisible();
  await expect(page.getByText("No active plan yet")).toBeVisible();

  // --- Seed the fixture and come back through the nav link. ---
  const room = await createRoomViaUi(page, { label: "analytics-room" });
  const ownerId = userIdByEmail(user.email);
  await seedAnalyticsFixture(room.id, ownerId);

  await analyticsNav.click();
  await page.waitForURL(/\/analytics$/);

  // UTC bucketing note (spec DoD: visibly stated).
  await expect(
    page.getByText(/Calendar dates are UTC — a session starting 23:30 UTC/),
  ).toBeVisible();
  await expect(page.getByText(/Current streak: 2 days · longest: 2 days/)).toBeVisible();

  // Summary strip: fixed numbers from the fixture, previous window and all.
  await expect(strip.getByText("85 min")).toBeVisible();
  await expect(strip.getByText("previous 7 days: 0 min")).toBeVisible();
  await expect(strip.getByText("80%", { exact: true })).toBeVisible();
  await expect(strip.getByText("4 of 5 correct · hardest: hard 80%")).toBeVisible();
  await expect(strip.getByText("10", { exact: true })).toBeVisible(); // cards due
  await expect(strip.getByText("1 of 1 created · 0 active")).toBeVisible();

  // Plan vs actual: window-scoped (tomorrow's item excluded).
  await expect(page.getByText(/60 min planned · 1 task \(1 done\)/)).toBeVisible();
  await expect(page.getByText(/85 min focused in this window/)).toBeVisible();

  // Goal ring: clamped progressbar semantics.
  const ring = page.getByRole("progressbar");
  await expect(ring).toHaveAttribute("aria-valuenow", "1");
  await expect(ring).toHaveAttribute("aria-valuemax", "1");
  // Scoped: the accuracy chart's y-axis label is also "100%" in the tree.
  const goalSection = page.getByRole("region", { name: "Goal completion" });
  await expect(goalSection.getByText("100%")).toBeVisible();

  // Charts expose role=img and the sr-only text tables (details copies are
  // collapsed, so only the sr-only pair is in the tree right now).
  await expect(
    page.getByRole("img", { name: /Daily focus minutes/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Daily quiz accuracy/ }),
  ).toBeVisible();
  const focusTable = page.getByRole("table", {
    name: "Daily focus minutes (text alternative to the chart)",
  });
  await expect(focusTable.locator("tbody tr")).toHaveCount(7);
  await expect(
    page
      .getByRole("table", { name: "Daily quiz accuracy (text alternative to the chart)" })
      .locator("tbody tr"),
  ).toHaveCount(7);

  // The collapsed details copy opens for sighted readers.
  await page.getByText("Show focus minutes data table").click();
  await expect(
    page.getByRole("table", { name: "Daily focus minutes", exact: true }),
  ).toBeVisible();

  // --- Range switch: URL + 30 rows, without losing the page. ---
  await page.getByLabel("Range", { exact: true }).selectOption("30d");
  await page.waitForURL(/range=30d/);
  await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
  await expect(focusTable.locator("tbody tr")).toHaveCount(30);
  await expect(strip.getByText("85 min")).toBeVisible(); // same fixture, wider window

  // --- CSV download of the current range. ---
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("study-analytics-30d.csv");
  const csv = readFileSync(await download.path() as string, "utf8");
  const lines = csv.trim().split("\n");
  expect(lines[0]).toBe(
    "date,focus_minutes,goals_completed,quizzes_taken,cards_reviewed,uploads",
  );
  expect(lines).toHaveLength(31);

  // An explicit but unknown range on the page is a 404 (the API answers
  // 400 for the same value — both asserted here and in the route tests).
  // Streaming makes notFound()'s HTTP status unreliable — repo convention
  // asserts the rendered 404 (see ask-my-notes.spec.ts).
  await page.goto("/analytics?range=1y");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("room analytics are owner-and-moderator only, with one identical 404 for everyone else", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const strangerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();
  const stranger = await strangerContext.newPage();

  try {
    const ownerUser = await signUpAndOnboard(owner, "analytics-room-owner");
    const room = await createRoomViaUi(owner, { label: "analytics-gate" });

    // The workspace offers the entry point to owner/moderators only.
    await expect(owner.getByRole("link", { name: "Room analytics" })).toBeVisible();
    await owner.getByRole("link", { name: "Room analytics" }).click();
    await owner.waitForURL(new RegExp(`/rooms/${room.id}/analytics$`));
    await expect(
      owner.getByRole("heading", { level: 1, name: "Room analytics" }),
    ).toBeVisible();
    await expect(owner.getByText("No activity in this range yet")).toBeVisible();
    await expect(owner.getByText(/Calendar dates are UTC/)).toBeVisible();
    await expect(owner.getByRole("link", { name: "Back to room" })).toBeVisible();
    // Counts only — no member-identifying rows anywhere in the payload view.
    await expect(owner.getByRole("region", { name: "Room summary" })).toBeVisible();

    // A plain member of the same room: no button, and the URL is a 404.
    const memberUser = await signUpAndOnboard(member, "analytics-room-member");
    await searchRooms(member, room.name);
    await joinRoomViaUi(member, room.name);
    await enterRoomViaUi(member, room.name);
    await expect(member.getByRole("link", { name: "Room analytics" })).toHaveCount(0);
    await member.goto(`/rooms/${room.id}/analytics`);
    await expect(member.getByRole("heading", { name: "Page not found" })).toBeVisible();

    // A stranger who has never seen the room: the identical rendered 404 —
    // membership stays unprovable from the URL.
    await signUpAndOnboard(stranger, "analytics-room-stranger");
    await stranger.goto(`/rooms/${room.id}/analytics`);
    await expect(stranger.getByRole("heading", { name: "Page not found" })).toBeVisible();

    // Appointing the member a moderator opens it; revoking closes it again —
    // the page re-proves the right through the RPC on every request.
    psql(
      `insert into public.room_moderators (room_id, user_id, granted_by) ` +
        `select '${room.id}', m.id, o.id from auth.users m, auth.users o ` +
        `where m.email = '${memberUser.email}' and o.email = '${ownerUser.email}';`,
    );
    try {
      const asModerator = await member.goto(`/rooms/${room.id}/analytics`);
      expect(asModerator?.status()).toBe(200);
      await expect(
        member.getByRole("heading", { level: 1, name: "Room analytics" }),
      ).toBeVisible();
    } finally {
      psql(
        `delete from public.room_moderators where room_id = '${room.id}' ` +
          `and user_id = (select id from auth.users where email = '${memberUser.email}');`,
      );
    }

    await member.goto(`/rooms/${room.id}/analytics`);
    await expect(member.getByRole("heading", { name: "Page not found" })).toBeVisible();
  } finally {
    await ownerContext.close();
    await memberContext.close();
    await strangerContext.close();
  }
});

test("the download path and the JSON path agree when reached directly", async ({ page }) => {
  const user = await signUpAndOnboard(page, "analytics-csv");
  const room = await createRoomViaUi(page, { label: "analytics-csv-room" });
  await seedAnalyticsFixture(room.id, userIdByEmail(user.email));

  await page.goto("/analytics");
  await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();

  // /api/analytics/me.csv straight from the browser session (cookie auth,
  // required range, forced attachment).
  const response = await page.request.get("/api/analytics/me.csv?range=7d");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/csv");
  expect(response.headers()["content-disposition"]).toContain(
    'filename="study-analytics-7d.csv"',
  );
  const [header, ...rows] = (await response.text()).trim().split("\n");
  expect(header).toBe(
    "date,focus_minutes,goals_completed,quizzes_taken,cards_reviewed,uploads",
  );
  expect(rows).toHaveLength(7);
  const focusTotal = rows.reduce(
    (sum, row) => sum + Number(row.split(",")[1]),
    0,
  );
  expect(focusTotal).toBe(85);

  // No range still fails on the download path, not silently defaulting.
  const missingRange = await page.request.get("/api/analytics/me.csv");
  expect(missingRange.status()).toBe(400);

  // Identity is never a parameter: ?user_id= is ignored.
  const plain = await page.request.get("/api/analytics/me?range=7d");
  const spoofed = await page.request.get(
    `/api/analytics/me?range=7d&user_id=00000000-0000-4000-8000-000000000000`,
  );
  expect((await plain.json())).toEqual(await spoofed.json());
});
