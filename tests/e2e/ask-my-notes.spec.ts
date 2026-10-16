import { expect, test } from "@playwright/test";
import { createRoomViaUi } from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";

/**
 * PR 13's definition of done, through the real interface: a member with an
 * indexed room document asks a question and gets the demo answer with
 * citations that link to the room's documents; the answer is persisted
 * (history survives a reload); a room without an indexed document shows the
 * disabled-and-explained entry instead of a hidden one; the ask page itself
 * says what to do; and a non-member gets the same 404 as a missing room.
 *
 * Every test signs up its own user: the ask rate limit (20/min per room)
 * and the daily chat quota are per-user, and `fullyParallel` runs these
 * beside the rest of the suite. Indexing runs on the mock provider — one
 * bounded step per POST — so no test ever waits on a real AI provider.
 */

/** Ingest on the mock provider: one bounded step per POST. */
const INDEX_TIMEOUT = 30_000;

type UploadedResource = { id: string };

/** Stores a room-scoped text file through the API and drives it to ready. */
async function seedRoomDocument(
  page: import("@playwright/test").Page,
  roomId: string,
  title: string,
  text: string,
): Promise<UploadedResource> {
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
  const { resource } = (await uploaded.json()) as { resource: UploadedResource };

  for (let step = 0; step < 8; step += 1) {
    const response = await page.request.post(`/api/ai/ingest/${resource.id}`);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { status: string };
    if (body.status === "ready") return resource;
    expect(body.status).not.toBe("failed");
  }
  throw new Error(`document ${resource.id} never reached ready`);
}

test("a member asks, gets the demo answer with real citations, and history survives a reload", async ({
  page,
}) => {
  await signUpAndOnboard(page, "ask-flow");
  const room = await createRoomViaUi(page, { label: "Ask flow" });
  await seedRoomDocument(
    page,
    room.id,
    "Mechanics notes",
    "Rotational motion: torque equals the rate of change of angular momentum.",
  );

  // Entry link appears once a document is indexed.
  await page.goto(`/rooms/${room.id}`);
  const entry = page.getByRole("link", { name: "Ask my notes" });
  await expect(entry).toBeVisible();
  await entry.click();
  await page.waitForURL(new RegExp(`/rooms/${room.id}/ask`));
  await expect(page.getByRole("heading", { level: 1, name: "Ask my notes" })).toBeVisible();

  // Demo-mode banner: asserted together with the server's own word for it,
  // so a runner configured with a real key fails loudly instead of silently.
  const usage = await page.request.get("/api/ai/usage");
  expect(usage.status()).toBe(200);
  expect(((await usage.json()) as { provider: string }).provider).toBe("mock");
  await expect(page.getByTestId("ask-demo-banner")).toBeVisible();

  await page.locator("#ask-question").fill("What is angular momentum?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();

  const transcript = page.getByTestId("ask-transcript");
  await expect(transcript).toContainText("What is angular momentum?");
  await expect(transcript).toContainText(
    "Demo mode: no AI provider is configured",
    { timeout: INDEX_TIMEOUT },
  );
  // The application-built Sources footer and the accessible citation link.
  await expect(transcript).toContainText("Sources: [1]");
  const sourceLink = transcript.getByRole("link", { name: /\[1\] Mechanics notes/ });
  await expect(sourceLink).toBeVisible();
  await expect(sourceLink).toHaveAttribute("href", `/rooms/${room.id}`);

  // History is stored server-side: a reload re-renders the same answer.
  await page.reload();
  await expect(page.getByTestId("ask-transcript")).toContainText(
    "Demo mode: no AI provider is configured",
  );
  await expect(page.getByTestId("ask-transcript")).toContainText(
    "Sources: [1] Mechanics notes",
  );

  // New question clears the composer without destroying the transcript.
  await page.locator("#ask-question").fill("half typed");
  await page.getByRole("button", { name: "New question" }).click();
  await expect(page.locator("#ask-question")).toHaveValue("");
  await expect(page.getByTestId("ask-transcript")).toContainText(
    "What is angular momentum?",
  );
});

test("a room without an indexed document disables-and-explains instead of hiding the entry", async ({
  page,
}) => {
  await signUpAndOnboard(page, "ask-empty");
  const room = await createRoomViaUi(page, { label: "Ask empty" });

  await page.goto(`/rooms/${room.id}`);
  const entry = page.getByRole("button", { name: /Ask my notes/ });
  await expect(entry).toBeVisible();
  await expect(entry).toBeDisabled();
  await expect(entry).toHaveAttribute(
    "title",
    "Index at least one document in Resources first.",
  );

  // Typing the URL anyway lands on an explanatory empty state, not a crash.
  await page.goto(`/rooms/${room.id}/ask`);
  await expect(
    page.getByRole("heading", { name: "Nothing to ask yet" }),
  ).toBeVisible();
  await expect(
    page.getByText("Index at least one document", { exact: false }),
  ).toBeVisible();
});

test("a non-member gets the same 404 for the ask page as for a missing room", async ({
  page,
}) => {
  await signUpAndOnboard(page, "ask-owner");
  const room = await createRoomViaUi(page, { label: "Ask owned" });

  // A second visitor, signed in but not a member of that room. Manual
  // contexts do not inherit the fixture's baseURL, so it is passed along.
  const browser = page.context().browser();
  if (!browser) throw new Error("browser unavailable");
  const strangerContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const stranger = await strangerContext.newPage();
  await signUpAndOnboard(stranger, "ask-stranger");

  // Streaming makes the HTTP status of a notFound() unreliable (the shell
  // can flush first) — the repo convention asserts the rendered 404 instead.
  await stranger.goto(`/rooms/${room.id}/ask`);
  await expect(
    stranger.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();

  // The API agrees: 404 for non-member, identical to a missing room.
  const missing = await stranger.request.get(
    "/api/rooms/99999999-9999-4999-8999-999999999999/ask/documents",
  );
  expect(missing.status()).toBe(404);
  const nonMember = await stranger.request.get(
    `/api/rooms/${room.id}/ask/documents`,
  );
  expect(nonMember.status()).toBe(404);

  await strangerContext.close();
});
