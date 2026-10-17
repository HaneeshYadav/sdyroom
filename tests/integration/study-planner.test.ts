import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import { POST as aiIngestPost } from "@/app/api/ai/ingest/[resourceId]/route";
import { GET as planDetailGet } from "@/app/api/plans/[planId]/route";
import { POST as archivePost } from "@/app/api/plans/[planId]/archive/route";
import { POST as completeDayPost } from "@/app/api/plans/[planId]/complete-day/route";
import { POST as itemDonePost } from "@/app/api/plans/[planId]/items/[itemId]/done/route";
import { POST as shiftPost } from "@/app/api/plans/[planId]/shift/route";
import { POST as stepPost } from "@/app/api/plans/[planId]/step/route";
import { GET as plansListGet, POST as plansCreatePost } from "@/app/api/plans/route";
import { POST as resourcesPost } from "@/app/api/resources/route";
import { computeProgress, type PlanProgress } from "@/lib/planner/progress";
import { addDaysIso, utcTodayIso } from "@/lib/planner/dates";
import { PLAN_KINDS, PLAN_MAX_ITEMS } from "@/lib/planner/validate";
import { PLAN_LIMIT } from "@/lib/rate-limit/keys";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { createRoomSchema } from "@/lib/validation/rooms";
import { psql, psqlExpectingFailure } from "./helpers/admin";
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

type CreatedPlan = {
  id: string;
  status: string;
  exam_date: string;
  deduped: boolean;
  href: string;
};

type PlanItem = {
  id: string;
  ordinal: number;
  date: string;
  subject: string | null;
  task: string;
  estimated_minutes: number;
  kind: string;
  resource_id: string | null;
  citation: { title: string; href: string } | null;
  done: boolean;
  done_at: string | null;
};

type PlanDetailBody = {
  plan: {
    id: string;
    status: string;
    exam_date: string;
    hours_per_day: number;
    summary: string | null;
    error_code: string | null;
    href: string;
    topics: string[];
    document_ids: string[];
  };
  items: PlanItem[];
  progress: PlanProgress;
  item_count: number;
  days: number;
};

type StepBody = {
  status: string;
  id: string;
  item_count: number | null;
  days: number | null;
  model: string | null;
  provider: string;
  error_code: string | null;
  deduped: boolean;
};

type Resource = { id: string; title: string };

function textFile(name: string, text: string): File {
  return new File([new TextEncoder().encode(text) as BlobPart], name, {
    type: "text/plain",
  });
}

async function upload(
  user: TestUser,
  fields: Record<string, string>,
  file: File,
): Promise<Resource> {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  await seedSession(user.email, user.password);
  const response = await callApi(resourcesPost, {
    path: "/api/resources",
    method: "POST",
    form,
  });
  expect(response.status).toBe(201);
  const body = await readJson(response);
  return body.resource as Resource;
}

/** Advances a personal document to `ready` (mock provider, no secrets). */
async function driveToReady(user: TestUser, resourceId: string): Promise<void> {
  await seedSession(user.email, user.password);
  for (let index = 0; index < 8; index += 1) {
    const response = await callApiWithParams(
      aiIngestPost,
      { path: `/api/ai/ingest/${resourceId}`, method: "POST" },
      { resourceId },
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    if (body.status === "ready") return;
    expect(body.status).not.toBe("failed");
  }
  throw new Error(`resource ${resourceId} never reached ready`);
}

// Route helpers — the session must already be seeded by the caller.

function postPlan(body: unknown): Promise<Response> {
  return callApi(plansCreatePost, { path: "/api/plans", method: "POST", body });
}

function listPlans(query = ""): Promise<Response> {
  return callApi(plansListGet, { path: `/api/plans${query}`, method: "GET" });
}

function getPlan(planId: string, query = ""): Promise<Response> {
  return callApiWithParams(
    planDetailGet,
    { path: `/api/plans/${planId}${query}`, method: "GET" },
    { planId },
  );
}

function step(planId: string): Promise<Response> {
  return callApiWithParams(
    stepPost,
    { path: `/api/plans/${planId}/step`, method: "POST" },
    { planId },
  );
}

function markDone(planId: string, itemId: string, body: unknown): Promise<Response> {
  return callApiWithParams(
    itemDonePost,
    { path: `/api/plans/${planId}/items/${itemId}/done`, method: "POST", body },
    { planId, itemId },
  );
}

function shift(planId: string, body: unknown): Promise<Response> {
  return callApiWithParams(
    shiftPost,
    { path: `/api/plans/${planId}/shift`, method: "POST", body },
    { planId },
  );
}

function completeDay(planId: string, body: unknown): Promise<Response> {
  return callApiWithParams(
    completeDayPost,
    { path: `/api/plans/${planId}/complete-day`, method: "POST", body },
    { planId },
  );
}

function archive(planId: string): Promise<Response> {
  return callApiWithParams(
    archivePost,
    { path: `/api/plans/${planId}/archive`, method: "POST" },
    { planId },
  );
}

async function readDetail(planId: string): Promise<PlanDetailBody> {
  const response = await getPlan(planId);
  expect(response.status).toBe(200);
  return (await readJson(response)) as unknown as PlanDetailBody;
}

/** POST → 201, drive one step → active, return the full detail. */
async function createAndDrive(body: Record<string, unknown>): Promise<PlanDetailBody> {
  const created = await postPlan({ hours_per_day: 1, ...body });
  expect(created.status).toBe(201);
  const { plan } = (await readJson(created)) as { plan: CreatedPlan };

  const stepped = await step(plan.id);
  expect(stepped.status).toBe(200);
  const stepBody = (await readJson(stepped)) as unknown as StepBody;
  expect(stepBody.status).toBe("active");

  return readDetail(plan.id);
}

function clearChatUsage(): void {
  psql(`delete from public.ai_usage where kind = 'chat_tokens';`);
}

function seedChatUsage(userId: string, amount: number): void {
  psql(
    `insert into public.ai_usage (room_id, user_id, kind, amount) ` +
      `values (null, '${userId}', 'chat_tokens', ${amount});`,
  );
}

function clearPlanRateLimit(): void {
  psql(`delete from public.rate_limits where key like 'plan:%';`);
}

function standardPlanBody(today: string): Record<string, unknown> {
  return {
    exam_date: addDaysIso(today, 14),
    hours_per_day: 1,
    topics: ["Algebra", "Geometry"],
  };
}

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let probeUser: TestUser;

let publicRoomId = "";
let privateRoomId = "";
let personalDocId = "";
let readyPersonalDocId = "";

const savedAiEnv = new Map<string, string | undefined>();
const today = utcTodayIso();

beforeAll(async () => {
  for (const key of ["AI_PROVIDER", "AI_API_KEY"] as const) {
    savedAiEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.AI_PROVIDER = "mock";

  [owner, member, outsider, probeUser] = await Promise.all([
    createUser("planner-owner"),
    createUser("planner-member"),
    createUser("planner-outsider"),
    createUser("planner-probe"),
  ]);
  await Promise.all(
    [owner, member, outsider, probeUser].map((user, index) =>
      createProfile(user.client, user.id, uniqueAlias(`PLAN${index}`)),
    ),
  );

  publicRoomId = (
    await createRoom(
      owner.client,
      createRoomSchema.parse({
        name: uniqueName("Planner Public"),
        capacity: 4,
        visibility: "public",
      }),
    )
  ).id;
  privateRoomId = (
    await createRoom(
      owner.client,
      createRoomSchema.parse({
        name: uniqueName("Planner Private"),
        capacity: 4,
        visibility: "private",
      }),
    )
  ).id;
  psql(
    `insert into public.room_members (room_id, user_id, role) ` +
      `values ('${publicRoomId}', '${member.id}', 'student');`,
  );

  personalDocId = (
    await upload(owner, { title: "Personal calculus notes" }, textFile("calc.txt", "The derivative of x^2 is 2x."))
  ).id;

  readyPersonalDocId = (
    await upload(
      owner,
      { title: "Indexed physics notes" },
      textFile(
        "physics.txt",
        "Newton's second law states that force equals mass times acceleration. " +
          "Energy is conserved in isolated systems.",
      ),
    )
  ).id;
  await driveToReady(owner, readyPersonalDocId);
});

afterAll(async () => {
  clearChatUsage();
  clearPlanRateLimit();
  await deleteUsers([owner, member, outsider, probeUser]);
  clearCookies();
  for (const [key, value] of savedAiEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  clearChatUsage();
  clearPlanRateLimit();
  // Each test owns its plans: the one-active invariant and pending-row reuse
  // are per user, so leftovers from the previous test must not leak in.
  psql(
    `delete from public.study_plans where user_id in (` +
      `'${owner.id}', '${member.id}', '${outsider.id}', '${probeUser.id}');`,
  );
  clearCookies();
});

describe("study planner — create and generate", () => {
  it("builds a personal plan end to end and serves valid detail", async () => {
    await seedSession(owner.email, owner.password);

    const created = await postPlan(standardPlanBody(today));
    expect(created.status).toBe(201);
    const first = (await readJson(created)) as { plan: CreatedPlan };
    expect(first.plan.status).toBe("generating");
    expect(first.plan.href).toBe(`/planner?plan=${first.plan.id}`);
    expect(first.plan.deduped).toBe(false);

    // A repeat create before the step resumes the pending row (the row holds
    // the request, never content) instead of colliding with the invariant.
    const again = await postPlan(standardPlanBody(today));
    expect(again.status).toBe(201);
    const second = (await readJson(again)) as { plan: CreatedPlan };
    expect(second.plan.id).toBe(first.plan.id);
    expect(second.plan.deduped).toBe(true);

    const stepped = await step(first.plan.id);
    expect(stepped.status).toBe(200);
    const stepBody = (await readJson(stepped)) as unknown as StepBody;
    expect(stepBody.status).toBe("active");
    expect(stepBody.item_count).toBeGreaterThan(0);
    expect(stepBody.item_count).toBeLessThanOrEqual(PLAN_MAX_ITEMS);
    expect(stepBody.days).toBeGreaterThan(1);
    expect(stepBody.provider).toBe("mock");
    expect(stepBody.model).toBeTruthy();

    // Idempotent replay: same state, no second spend.
    const replay = await step(first.plan.id);
    expect(replay.status).toBe(200);
    const replayBody = (await readJson(replay)) as unknown as StepBody;
    expect(replayBody.deduped).toBe(true);
    expect(replayBody.item_count).toBe(stepBody.item_count);

    const detail = await readDetail(first.plan.id);
    expect(detail.plan.status).toBe("active");
    expect(detail.items.length).toBe(stepBody.item_count);
    expect(detail.item_count).toBe(stepBody.item_count);
    expect(detail.days).toBe(stepBody.days);
    expect(detail.plan.summary).toBeTruthy();

    // Schedule validity: ordered, in-window, bounded kinds/minutes, per-day
    // budget (floor(60) + 15 at one hour a day).
    let previousDate = "";
    const perDay = new Map<string, number>();
    for (const item of detail.items) {
      expect(item.date >= today).toBe(true);
      expect(item.date <= detail.plan.exam_date).toBe(true);
      expect(item.date >= previousDate).toBe(true);
      previousDate = item.date;
      expect(PLAN_KINDS).toContain(item.kind);
      expect(item.estimated_minutes).toBeGreaterThanOrEqual(1);
      expect(item.estimated_minutes).toBeLessThanOrEqual(480);
      expect(item.task.length).toBeGreaterThan(0);
      expect(item.task.length).toBeLessThanOrEqual(300);
      if (item.subject !== null) {
        expect(item.subject.length).toBeLessThanOrEqual(60);
      }
      perDay.set(item.date, (perDay.get(item.date) ?? 0) + item.estimated_minutes);
    }
    for (const [, minutes] of perDay) {
      expect(minutes).toBeLessThanOrEqual(60 + 15);
    }

    // The client's mirror of plan_progress must equal the SQL authority.
    expect(detail.progress).toEqual(computeProgress(detail.items, today));
    expect(detail.progress.done).toBe(0);
    expect(detail.progress.total).toBe(detail.item_count);
  });

  it("grounds a plan in an indexed personal document and cites it", async () => {
    await seedSession(owner.email, owner.password);
    const detail = await createAndDrive({
      ...standardPlanBody(today),
      document_ids: [readyPersonalDocId],
    });
    expect(detail.plan.status).toBe("active");

    const cited = detail.items.filter((item) => item.resource_id !== null);
    expect(cited.length).toBeGreaterThan(0);
    for (const item of cited) {
      expect(item.resource_id).toBe(readyPersonalDocId);
      expect(item.citation).not.toBeNull();
      expect(item.citation?.title).toBe("Indexed physics notes");
      expect(item.citation?.href).toBe("/resources");
    }
  });

  it("strips citations when the document has no indexed chunks", async () => {
    await seedSession(owner.email, owner.password);
    const detail = await createAndDrive({
      ...standardPlanBody(today),
      document_ids: [personalDocId],
    });
    // Never-ingested upload: retrieval returns nothing, so no item may
    // pretend to be grounded — topic tasks only, all citations null.
    expect(detail.plan.status).toBe("active");
    for (const item of detail.items) {
      expect(item.resource_id).toBeNull();
      expect(item.citation).toBeNull();
    }
  });

  it("rejects invalid create bodies", async () => {
    await seedSession(owner.email, owner.password);

    const examToday = await postPlan({ ...standardPlanBody(today), exam_date: today });
    expect(examToday.status).toBe(400);
    expect(errorOf(await readJson(examToday)).code).toBe("validation");

    const tooFar = await postPlan({
      ...standardPlanBody(today),
      exam_date: addDaysIso(today, 400),
    });
    expect(tooFar.status).toBe(400);

    const badHours = await postPlan({ ...standardPlanBody(today), hours_per_day: 0 });
    expect(badHours.status).toBe(400);

    const longTopic = await postPlan({
      ...standardPlanBody(today),
      topics: ["x".repeat(61)],
    });
    expect(longTopic.status).toBe(400);

    const forged = await postPlan({
      ...standardPlanBody(today),
      user_id: outsider.id,
    });
    expect(forged.status).toBe(400);

    const malformed = await postPlan(undefined);
    expect(malformed.status).toBe(400);
    expect(errorOf(await readJson(malformed)).code).toBe("invalid_json");

    const raw = await callApi(plansCreatePost, {
      path: "/api/plans",
      method: "POST",
      rawBody: "{",
    });
    expect(raw.status).toBe(400);
    expect(errorOf(await readJson(raw)).code).toBe("invalid_json");
  });

  it("enforces the one-active invariant and regenerate", async () => {
    await seedSession(owner.email, owner.password);

    const first = await createAndDrive(standardPlanBody(today));
    expect(first.plan.status).toBe("active");

    const blocked = await postPlan(standardPlanBody(today));
    expect(blocked.status).toBe(409);
    expect(errorOf(await readJson(blocked)).code).toBe("plan_already_active");

    const regenerated = await postPlan({
      ...standardPlanBody(today),
      regenerate: true,
    });
    expect(regenerated.status).toBe(201);
    const { plan: newPlan } = (await readJson(regenerated)) as { plan: CreatedPlan };
    expect(newPlan.id).not.toBe(first.plan.id);

    const oldDetail = await readDetail(first.plan.id);
    expect(oldDetail.plan.status).toBe("archived");

    const stepped = await step(newPlan.id);
    expect(stepped.status).toBe(200);
    expect(((await readJson(stepped)) as unknown as StepBody).status).toBe("active");
  });

  it("exports the plan as a CSV attachment", async () => {
    await seedSession(owner.email, owner.password);
    const detail = await createAndDrive(standardPlanBody(today));

    const csv = await getPlan(detail.plan.id, "?format=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain(
      `filename="study-plan-${detail.plan.id}.csv"`,
    );
    const csvText = await csv.text();
    const lines = csvText
      .trim()
      .split("\n");
    expect(lines[0]).toBe("date,kind,subject,task,est_minutes,done");
    expect(lines.length).toBe(detail.item_count + 1);

    // The `<uuid>.csv` suffix form resolves to the same download.
    const suffixed = await getPlan(`${detail.plan.id}.csv`);
    expect(suffixed.status).toBe(200);
    expect(suffixed.headers.get("content-type")).toContain("text/csv");
  });
});

describe("study planner — actions", () => {
  it("marks items done idempotently and completes whole days", async () => {
    await seedSession(owner.email, owner.password);
    const detail = await createAndDrive(standardPlanBody(today));
    const firstItem = detail.items[0];

    const doneResponse = await markDone(detail.plan.id, firstItem.id, { done: true });
    expect(doneResponse.status).toBe(200);
    const doneBody = (await readJson(doneResponse)) as {
      item: { id: string; done_at: string | null };
      plan: { status: string; progress: PlanProgress };
    };
    expect(doneBody.item.done_at).not.toBeNull();
    expect(doneBody.plan.progress.done).toBe(1);
    const firstDoneAt = doneBody.item.done_at;

    // Repeat: same state, first completion timestamp never rewritten.
    const repeat = await markDone(detail.plan.id, firstItem.id, { done: true });
    const repeatBody = (await readJson(repeat)) as typeof doneBody;
    expect(repeatBody.item.done_at).toBe(firstDoneAt);
    expect(repeatBody.plan.progress.done).toBe(1);

    const unmarked = await markDone(detail.plan.id, firstItem.id, { done: false });
    const unmarkBody = (await readJson(unmarked)) as typeof doneBody;
    expect(unmarkBody.item.done_at).toBeNull();
    expect(unmarkBody.plan.progress.done).toBe(0);

    // Whole-day completion: only untouched items of that date are written.
    const fresh = await readDetail(detail.plan.id);
    const todayItems = fresh.items.filter((item) => item.date === today);
    const completed = await completeDay(detail.plan.id, { date: today });
    expect(completed.status).toBe(200);
    const completedBody = (await readJson(completed)) as {
      completed: number;
      progress: PlanProgress;
    };
    expect(completedBody.completed).toBe(todayItems.length);
    expect(completedBody.progress.done).toBe(todayItems.length);

    const secondDay = await completeDay(detail.plan.id, { date: today });
    const secondBody = (await readJson(secondDay)) as typeof completedBody;
    expect(secondBody.completed).toBe(0);
    expect(secondBody.progress.done).toBe(todayItems.length);

    const after = await readDetail(detail.plan.id);
    expect(after.progress).toEqual(computeProgress(after.items, today));
  });

  it("shifts remaining items forward and clamps at the exam date", async () => {
    await seedSession(owner.email, owner.password);
    const detail = await createAndDrive(standardPlanBody(today));

    // Simulate falling behind: one undone item lingers from three days ago.
    const backdated = detail.items[0].id;
    psql(
      `update public.plan_items set item_date = '${addDaysIso(today, -3)}' ` +
        `where id = '${backdated}';`,
    );

    const missed = await shift(detail.plan.id, { from_date: addDaysIso(today, -3) });
    expect(missed.status).toBe(200);
    const shiftBody = (await readJson(missed)) as {
      plan: { status: string; exam_date: string };
      moved: number;
      past_exam_date: number;
      skipped_done: number;
    };
    expect(shiftBody.plan.status).toBe("active");
    // Every in-window undone item moves — except one already sitting on the
    // exam date: its full shift would pass the exam, so it stays put (and
    // lands in `past_exam_date` instead of being dropped).
    const alreadyOnExam = detail.items.filter(
      (item) => item.date === detail.plan.exam_date,
    ).length;
    expect(shiftBody.moved).toBe(detail.item_count - alreadyOnExam);
    expect(alreadyOnExam).toBeGreaterThan(0);
    expect(shiftBody.skipped_done).toBe(0);
    // Items whose full +3-day shift would pass the exam are clamped onto it
    // and counted, never silently dropped.
    expect(shiftBody.past_exam_date).toBeGreaterThan(0);

    const shifted = await readDetail(detail.plan.id);
    for (const item of shifted.items) {
      expect(item.date <= shifted.plan.exam_date).toBe(true);
      expect(item.date >= today).toBe(true);
    }

    // Documented rule: a repeat from the same `from_date` applies the same
    // advance again (the call is a relative nudge the UI confirms) — items
    // still never land past the exam, and clamped items stay put.
    const replay = await shift(detail.plan.id, { from_date: addDaysIso(today, -3) });
    const replayBody = (await readJson(replay)) as typeof shiftBody;
    expect(replayBody.moved).toBeGreaterThan(0);
    expect(replayBody.moved).toBeLessThanOrEqual(shiftBody.moved);
    const replayed = await readDetail(detail.plan.id);
    for (const item of replayed.items) {
      expect(item.date <= replayed.plan.exam_date).toBe(true);
    }

    // The "already on time" no-op: a window starting today computes shift 0.
    const noop = await shift(detail.plan.id, { from_date: today });
    const noopBody = (await readJson(noop)) as typeof shiftBody;
    expect(noopBody.moved).toBe(0);
    expect(noopBody.past_exam_date).toBe(0);
  });

  it("archives idempotently and makes the plan read-only", async () => {
    await seedSession(owner.email, owner.password);
    const detail = await createAndDrive(standardPlanBody(today));
    const itemId = detail.items[0].id;

    const archived = await archive(detail.plan.id);
    expect(archived.status).toBe(200);
    expect(((await readJson(archived)) as { archived: boolean }).archived).toBe(true);

    const again = await archive(detail.plan.id);
    expect(again.status).toBe(200);
    expect(((await readJson(again)) as { deduped: boolean }).deduped).toBe(true);

    const doneAfter = await markDone(detail.plan.id, itemId, { done: true });
    expect(doneAfter.status).toBe(409);
    expect(errorOf(await readJson(doneAfter)).code).toBe("plan_not_active");

    const dayAfter = await completeDay(detail.plan.id, { date: today });
    expect(dayAfter.status).toBe(409);

    const shiftAfter = await shift(detail.plan.id, { from_date: today });
    expect(shiftAfter.status).toBe(409);

    const stepAfter = await step(detail.plan.id);
    expect(stepAfter.status).toBe(409);
    expect(errorOf(await readJson(stepAfter)).code).toBe("plan_not_active");
  });

  it("cancels a pending generation via archive", async () => {
    await seedSession(owner.email, owner.password);
    const created = await postPlan(standardPlanBody(today));
    const { plan } = (await readJson(created)) as { plan: CreatedPlan };

    const cancelled = await archive(plan.id);
    expect(cancelled.status).toBe(200);

    const stepped = await step(plan.id);
    expect(stepped.status).toBe(409);
    expect(errorOf(await readJson(stepped)).code).toBe("plan_not_active");
  });
});

describe("study planner — access control", () => {
  it("answers 403 for a public room non-member and 404 for a private one", async () => {
    await seedSession(outsider.email, outsider.password);

    const publicAttempt = await postPlan({
      ...standardPlanBody(today),
      room_id: publicRoomId,
    });
    expect(publicAttempt.status).toBe(403);
    expect(errorOf(await readJson(publicAttempt)).code).toBe("room_not_member");

    const privateAttempt = await postPlan({
      ...standardPlanBody(today),
      room_id: privateRoomId,
    });
    expect(privateAttempt.status).toBe(404);
    expect(errorOf(await readJson(privateAttempt)).code).toBe("not_found");

    const missingRoom = await postPlan({
      ...standardPlanBody(today),
      room_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(missingRoom.status).toBe(404);
  });

  it("lets a room member create a room-scoped plan", async () => {
    await seedSession(member.email, member.password);
    const created = await postPlan({
      ...standardPlanBody(today),
      room_id: publicRoomId,
    });
    expect(created.status).toBe(201);
    const { plan } = (await readJson(created)) as { plan: CreatedPlan };
    const stepped = await step(plan.id);
    expect(stepped.status).toBe(200);
    expect(((await readJson(stepped)) as unknown as StepBody).status).toBe("active");
  });

  it("enforces document accessibility at the route", async () => {
    await seedSession(owner.email, owner.password);

    const roomDoc = await upload(
      owner,
      { title: "Room-only notes", room_id: publicRoomId },
      textFile("room.txt", "Room scoped content."),
    );

    // A personal file in a personal plan: fine.
    const ownPersonal = await postPlan({
      ...standardPlanBody(today),
      document_ids: [personalDocId],
    });
    expect(ownPersonal.status).toBe(201);

    // A file belonging to nobody the caller can reach: 400.
    const forged = await postPlan({
      ...standardPlanBody(today),
      document_ids: ["00000000-0000-4000-8000-000000000000"],
    });
    expect(forged.status).toBe(400);
    expect(errorOf(await readJson(forged)).code).toBe("validation");

    // A room file outside any room link: 400 (never silently re-scoped).
    const roomDocPersonal = await postPlan({
      ...standardPlanBody(today),
      document_ids: [roomDoc.id],
    });
    expect(roomDocPersonal.status).toBe(400);

    // Someone else's personal file: 400 (RLS hides it, the rule rejects it).
    await seedSession(outsider.email, outsider.password);
    const stolen = await postPlan({
      ...standardPlanBody(today),
      document_ids: [personalDocId],
    });
    expect(stolen.status).toBe(400);
  });

  it("answers 404 to another user on every plan endpoint", async () => {
    await seedSession(owner.email, owner.password);
    const mine = await createAndDrive(standardPlanBody(today));
    const itemId = mine.items[0].id;

    await seedSession(outsider.email, outsider.password);

    const read = await getPlan(mine.plan.id);
    expect(read.status).toBe(404);

    const stepped = await step(mine.plan.id);
    expect(stepped.status).toBe(404);

    const toggled = await markDone(mine.plan.id, itemId, { done: true });
    expect(toggled.status).toBe(404);

    const shifted = await shift(mine.plan.id, { from_date: today });
    expect(shifted.status).toBe(404);

    const completed = await completeDay(mine.plan.id, { date: today });
    expect(completed.status).toBe(404);

    const archived = await archive(mine.plan.id);
    expect(archived.status).toBe(404);

    // And the plan never appears in the outsider's list.
    const list = await listPlans("?status=active");
    expect(list.status).toBe(200);
    const body = (await readJson(list)) as { plans: { id: string }[] };
    expect(body.plans.some((plan) => plan.id === mine.plan.id)).toBe(false);
  });

  it("answers 401 to every endpoint without a session", async () => {
    const created = await postPlan(standardPlanBody(today));
    expect(created.status).toBe(401);

    const listed = await listPlans();
    expect(listed.status).toBe(401);

    const fakeId = "00000000-0000-4000-8000-000000000000";
    expect((await getPlan(fakeId)).status).toBe(401);
    expect((await step(fakeId)).status).toBe(401);
    expect((await markDone(fakeId, fakeId, { done: true })).status).toBe(401);
    expect((await shift(fakeId, { from_date: today })).status).toBe(401);
    expect((await completeDay(fakeId, { date: today })).status).toBe(401);
    expect((await archive(fakeId)).status).toBe(401);
  });
});

describe("study planner — quota, limits, SQL authority", () => {
  it("refuses creation and fails the step at the daily chat cap", async () => {
    await seedSession(owner.email, owner.password);
    seedChatUsage(owner.id, 100_000);

    const blocked = await postPlan(standardPlanBody(today));
    expect(blocked.status).toBe(403);
    expect(errorOf(await readJson(blocked)).code).toBe("ai_quota_exceeded");

    // A pending plan created before the cap: the step fails it honestly.
    clearChatUsage();
    const created = await postPlan(standardPlanBody(today));
    expect(created.status).toBe(201);
    const { plan } = (await readJson(created)) as { plan: CreatedPlan };

    seedChatUsage(owner.id, 100_000);
    const stepped = await step(plan.id);
    expect(stepped.status).toBe(403);
    expect(errorOf(await readJson(stepped)).code).toBe("ai_quota_exceeded");

    const detail = await readDetail(plan.id);
    expect(detail.plan.status).toBe("failed");
    expect(detail.plan.error_code).toBe("ai_quota_exceeded");
  });

  it("applies the plan rate limit per scope and user", async () => {
    clearPlanRateLimit();
    await seedSession(owner.email, owner.password);
    for (let index = 0; index < PLAN_LIMIT.max; index += 1) {
      const response = await postPlan(standardPlanBody(today));
      expect(response.status).toBe(201);
    }
    const limited = await postPlan(standardPlanBody(today));
    expect(limited.status).toBe(429);
    expect(errorOf(await readJson(limited)).code).toBe("rate_limited");
  });

  it("lists plans newest-first with a status filter", async () => {
    await seedSession(owner.email, owner.password);
    const detail = await createAndDrive(standardPlanBody(today));

    const active = await listPlans("?status=active");
    expect(active.status).toBe(200);
    const activeBody = (await readJson(active)) as { plans: { id: string }[] };
    expect(activeBody.plans.some((plan) => plan.id === detail.plan.id)).toBe(true);

    const archived = await listPlans("?status=archived");
    const archivedBody = (await readJson(archived)) as { plans: { id: string }[] };
    expect(archivedBody.plans.some((plan) => plan.id === detail.plan.id)).toBe(false);

    const badFilter = await listPlans("?status=bogus");
    expect(badFilter.status).toBe(400);
  });

  it("refuses plan_invalid from the SQL validator and leaves the row pending", async () => {
    await seedSession(owner.email, owner.password);
    const created = await postPlan(standardPlanBody(today));
    const { plan } = (await readJson(created)) as { plan: CreatedPlan };

    // Direct PostgREST call with an empty item array: the database is the
    // authority on payload validity, independent of any route.
    const rejected = await owner.client.rpc("generate_plan", {
      p_plan_id: plan.id,
      p_items: [],
      p_summary: "nope",
      p_model: "direct",
      p_prompt_tokens: 0,
      p_completion_tokens: 0,
      p_retrieval_tokens: 0,
    });
    expect(rejected.error).not.toBeNull();
    expect(rejected.error?.message).toContain("plan_invalid");

    const detail = await readDetail(plan.id);
    expect(detail.plan.status).toBe("generating");
    expect(detail.item_count).toBe(0);
  });
});

describe("study planner — direct PostgREST probes", () => {
  it("refuses the RPCs without a session (42501) and without execute rights", async () => {
    const { apiUrl, publishableKey } = integrationEnv();
    const anon = createClient(apiUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    // create_plan is granted to `authenticated` only: the anon role cannot
    // even resolve a callable function, so no row can ever appear.
    const anonCreate = await anon.rpc("create_plan", {
      p_user_id: probeUser.id,
      p_room_id: null,
      p_exam_date: addDaysIso(today, 30),
      p_hours_per_day: 1,
      p_topics: [],
      p_document_ids: [],
      p_regenerate: false,
    });
    expect(anonCreate.error).not.toBeNull();
    expect(psql(
      `select count(*) from public.study_plans where user_id = '${probeUser.id}';`,
    ).trim()).toBe("0");

    // plan_progress is internal: execute revoked from every app role.
    const anonProgress = await anon.rpc("plan_progress", {
      p_plan_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(anonProgress.error).not.toBeNull();
    expect(
      psql(
        `select has_function_privilege('authenticated', 'public.plan_progress(uuid)', 'EXECUTE');`,
      ).trim(),
    ).toBe("f");
    const authedProgress = await probeUser.client.rpc("plan_progress", {
      p_plan_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(authedProgress.error).not.toBeNull();
  });

  it("refuses a create_plan p_user_id that is not the session user", async () => {
    const before = psql(
      `select count(*) from public.study_plans where user_id = '${probeUser.id}';`,
    ).trim();
    const mismatched = await probeUser.client.rpc("create_plan", {
      p_user_id: owner.id,
      p_room_id: null,
      p_exam_date: addDaysIso(today, 30),
      p_hours_per_day: 1,
      p_topics: [],
      p_document_ids: [],
      p_regenerate: false,
    });
    expect(mismatched.error?.message).toContain("not_owner");
    expect(
      psql(`select count(*) from public.study_plans where user_id = '${probeUser.id}';`).trim(),
    ).toBe(before);
    expect(
      psql(
        `select count(*) from public.study_plans where user_id = '${owner.id}' ` +
          `and model = 'direct';`,
      ).trim(),
    ).toBe("0");
  });

  it("answers not_found when another user drives a foreign plan RPC", async () => {
    await seedSession(owner.email, owner.password);
    const detail = await createAndDrive(standardPlanBody(today));
    const itemId = detail.items[0].id;

    const foreignToggle = await outsider.client.rpc("mark_plan_item", {
      p_item_id: itemId,
      p_done: true,
    });
    expect(foreignToggle.error?.message).toContain("not_found");

    const foreignArchive = await outsider.client.rpc("archive_plan", {
      p_plan_id: detail.plan.id,
    });
    expect(foreignArchive.error?.message).toContain("not_found");

    // Nothing changed: the item is still undone in the database.
    expect(
      psql(`select done_at is null from public.plan_items where id = '${itemId}';`).trim(),
    ).toBe("t");
  });

  it("enforces the partial unique index with a 23505 probe", async () => {
    const probeId = probeUser.id;
    psql(`delete from public.study_plans where user_id = '${probeId}';`);
    psql(
      `insert into public.study_plans (user_id, status, exam_date, hours_per_day, generated_at) ` +
        `values ('${probeId}', 'active', '${addDaysIso(today, 30)}', 1, now());`,
    );
    const duplicate = psqlExpectingFailure(
      `insert into public.study_plans (user_id, status, exam_date, hours_per_day, generated_at) ` +
        `values ('${probeId}', 'active', '${addDaysIso(today, 30)}', 1, now());`,
    );
    expect(duplicate.output).toContain("study_plans_one_active");

    // The one-generating twin behaves the same for pending rows.
    psql(`delete from public.study_plans where user_id = '${probeId}';`);
    psql(
      `insert into public.study_plans (user_id, status, exam_date, hours_per_day) ` +
        `values ('${probeId}', 'generating', '${addDaysIso(today, 30)}', 1);`,
    );
    const duplicatePending = psqlExpectingFailure(
      `insert into public.study_plans (user_id, status, exam_date, hours_per_day) ` +
        `values ('${probeId}', 'generating', '${addDaysIso(today, 30)}', 1);`,
    );
    expect(duplicatePending.output).toContain("study_plans_one_generating");
    psql(`delete from public.study_plans where user_id = '${probeId}';`);
  });

  it("grants app roles no insert/update on the tables (RPC-only writes)", async () => {
    expect(
      psql(
        `select count(*) from information_schema.role_table_grants ` +
          `where table_name in ('study_plans', 'plan_items') ` +
          `and grantee in ('authenticated', 'anon', 'service_role') ` +
          `and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`,
      ).trim(),
    ).toBe("0");
  });
});
