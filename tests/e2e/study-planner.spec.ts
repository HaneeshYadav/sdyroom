import { expect, test, type Page } from "@playwright/test";
import { createRoomViaUi } from "./helpers/rooms";
import { signUpAndOnboard, waitForHydration } from "./helpers/users";

/**
 * PR 15's definition of done, through the real interface on the mock
 * provider: a student builds a plan, lives with it (check off, reload,
 * mark a day done, shift what remains), gets the honest 409 when a second
 * plan would collide, and sees the documented "no indexed documents" note
 * on a topic-only plan. Access rules — another student's plan id is a 404,
 * the API demands a session — are asserted from a second browser context
 * and an unauthenticated one.
 *
 * Every test signs up its own user: plan creation and step each consume the
 * per-scope plan rate limit (10/min), and `fullyParallel` runs these beside
 * the rest of the suite. Generation is one bounded step on the mock, so no
 * test ever waits on a real AI provider.
 */

/** Create and step each run one bounded POST on the mock. */
const STEP_TIMEOUT = 30_000;

/** A valid exam date a few weeks out — inside the 180-day window. */
function examDateAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Stores a room-scoped text file through the API and drives it to ready. */
async function seedRoomDocument(
  page: Page,
  roomId: string,
  title: string,
  text: string,
): Promise<void> {
  const uploaded = await page.request.post("/api/resources", {
    multipart: {
      file: {
        name: `${title.toLowerCase().replace(/\s+/g, "-")}.txt`,
        mimeType: "text/plain",
        buffer: Buffer.from(text),
      },
      title,
      room_id: roomId,
    },
  });
  expect(uploaded.status()).toBe(201);
  const { resource } = (await uploaded.json()) as {
    resource: { id: string };
  };

  for (let step = 0; step < 8; step += 1) {
    const response = await page.request.post(`/api/ai/ingest/${resource.id}`);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { status: string };
    if (body.status === "ready") return;
    expect(body.status).not.toBe("failed");
  }
  throw new Error(`document never reached ready`);
}

/** Drives the setup form to a generated, active plan (topic-only). */
async function generatePlanViaUi(page: Page, topic: string): Promise<void> {
  await page.goto("/planner");
  await waitForHydration(page, "#plan-exam-date");
  await page.locator("#plan-exam-date").fill(examDateAhead(21));
  await page.locator("#plan-hours").fill("1");
  await page.locator("#plan-topic-draft").fill(topic);
  await page.getByRole("button", { name: "Add topic" }).click();
  await page.getByRole("button", { name: "Generate plan" }).click();
  // The generating panel drives the one step itself; the page then swaps to
  // the active checklist.
  await expect(
    page.getByRole("heading", { name: "Current plan" }),
  ).toBeVisible({ timeout: STEP_TIMEOUT });
}

test("a student generates a topic-only plan, lives with it, and shifts what remains", async ({
  page,
}) => {
  await signUpAndOnboard(page, "planner-topic");
  await generatePlanViaUi(page, "Integration by parts");

  // Grouped checklist: Today first, progress authority on screen, and the
  // documented no-documents note for a topic-only plan. (exact: the day
  // block's h3 heading also contains the word "Today" in its badge.)
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Upcoming", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download CSV" })).toBeVisible();
  // The plan's own note (the page header's demo banner is also a note).
  await expect(
    page
      .getByRole("note")
      .filter({ hasText: "No indexed documents are attached" }),
  ).toBeVisible();

  // Check an item: progress moves immediately, and the write lands on the
  // server before we navigate away (the optimistic flip alone is not enough
  // to prove persistence).
  const firstCheckbox = page.getByRole("checkbox").first();
  const [toggleResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/items/") &&
        response.url().includes("/done") &&
        response.request().method() === "POST",
    ),
    firstCheckbox.check(),
  ]);
  expect(toggleResponse.status()).toBe(200);
  const totalText = await page
    .getByText(/\d+ of \d+ items done/)
    .first()
    .textContent();
  expect(totalText).toMatch(/^1 of \d+ items done/);

  // Reload: the server's done_at persisted.
  await page.reload();
  await expect(page.getByRole("checkbox").first()).toBeChecked();
  await expect(page.getByText(/^1 of \d+ items done/).first()).toBeVisible();

  // Mark the rest of today done — deterministic, no AI involved.
  await page.getByRole("button", { name: "Mark all of today done" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    /Marked all of today's tasks done/,
  );

  // Shift what remains: two-step confirm, then the count comes back.
  await page
    .getByRole("button", { name: "I missed today — shift remaining" })
    .click();
  await page.getByRole("button", { name: "Confirm shift" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    /Moved \d+ remaining tasks? forward|already on time/,
  );
});

test("a grounded plan cites the room document, a second generate 409s, regenerate loops", async ({
  page,
}) => {
  await signUpAndOnboard(page, "planner-grounded");
  const room = await createRoomViaUi(page, { label: "Planner grounded" });
  await seedRoomDocument(
    page,
    room.id,
    "Mechanics notes",
    "Projectile motion: range is maximized at 45 degrees launch angle.",
  );

  // The room's Study plan entry preselects the scope and pins its ready docs.
  await page.goto(`/rooms/${room.id}`);
  await page.getByRole("link", { name: "Study plan" }).click();
  await page.waitForURL(/\/planner\?room=/);
  await waitForHydration(page, "#plan-exam-date");
  await expect(page.getByText(/Grounded in 1 ready document/)).toBeVisible();

  await page.locator("#plan-exam-date").fill(examDateAhead(21));
  await page.locator("#plan-hours").fill("1");
  await page.getByRole("button", { name: "Generate plan" }).click();
  await expect(
    page.getByRole("heading", { name: "Current plan" }),
  ).toBeVisible({ timeout: STEP_TIMEOUT });

  // Every read task either cites the accessible document or nothing at all —
  // here the citation the mock retrieved from the pinned doc is on screen.
  await expect(page.getByRole("link", { name: "Mechanics notes" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the linked room" })).toBeVisible();

  const listed = await page.request.get("/api/plans?status=active");
  expect(listed.status()).toBe(200);
  const { plans } = (await listed.json()) as {
    plans: Array<{ id: string }>;
  };
  expect(plans.length).toBe(1);
  const planId = plans[0].id;

  // CSV download: the spec's columns as an attachment.
  const csv = await page.request.get(`/api/plans/${planId}?format=csv`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(csv.headers()["content-disposition"]).toContain(
    `study-plan-${planId}.csv`,
  );
  expect(await csv.text()).toContain("date,kind,subject,task,est_minutes,done");

  // A second generate without regenerate is a clear 409, not a second plan.
  const collide = await page.request.post("/api/plans", {
    data: { exam_date: examDateAhead(25), hours_per_day: 1 },
  });
  expect(collide.status()).toBe(409);
  expect(((await collide.json()) as { error: { code: string } }).error.code).toBe(
    "plan_already_active",
  );

  // With regenerate the database archives the old plan and starts a new one;
  // the page's generating panel drives the step and the checklist returns.
  const regenerated = await page.request.post("/api/plans", {
    data: {
      exam_date: examDateAhead(25),
      hours_per_day: 1,
      regenerate: true,
    },
  });
  expect(regenerated.status()).toBe(201);
  await page.goto("/planner");
  await expect(
    page.getByRole("heading", { name: "Current plan" }),
  ).toBeVisible({ timeout: STEP_TIMEOUT });
});

test("another student's plan id is a 404 and the API requires a session", async ({
  browser,
}) => {
  // Manual contexts do not inherit the fixture's baseURL, so it is passed
  // along (the repo convention for multi-context specs).
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("baseURL unavailable");

  // The owner generates a plan through the API (one mock step to active).
  const ownerContext = await browser.newContext({ baseURL });
  const owner = await ownerContext.newPage();
  await signUpAndOnboard(owner, "planner-owner");
  const created = await owner.request.post("/api/plans", {
    data: { exam_date: examDateAhead(21), hours_per_day: 1, topics: ["Vectors"] },
  });
  expect(created.status()).toBe(201);
  const { plan } = (await created.json()) as { plan: { id: string } };
  const stepped = await owner.request.post(`/api/plans/${plan.id}/step`);
  expect(stepped.status()).toBe(200);

  // A different student: the page renders the same 404 a missing id gives
  // (streaming makes the HTTP status of notFound() unreliable — the repo
  // convention asserts the rendered 404 instead), and every API surface
  // answers 404.
  const otherContext = await browser.newContext({ baseURL });
  const other = await otherContext.newPage();
  await signUpAndOnboard(other, "planner-other");
  await other.goto(`/planner?plan=${plan.id}`);
  await expect(
    other.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
  const apiRead = await other.request.get(`/api/plans/${plan.id}`);
  expect(apiRead.status()).toBe(404);
  const apiShift = await other.request.post(`/api/plans/${plan.id}/shift`, {
    data: { from_date: examDateAhead(1) },
  });
  expect(apiShift.status()).toBe(404);

  // No session at all: the API is 401 and the page hands the browser to login.
  const anonContext = await browser.newContext({ baseURL });
  const anon = await anonContext.newPage();
  const anonApi = await anon.request.get(`/api/plans/${plan.id}`);
  expect(anonApi.status()).toBe(401);
  await anon.goto(`/planner?plan=${plan.id}`);
  await expect(anon).toHaveURL(/\/auth\/login/);

  await ownerContext.close();
  await otherContext.close();
  await anonContext.close();
});
