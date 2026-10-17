import { expect, test } from "@playwright/test";
import { createRoomViaUi } from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";

/**
 * PR 14's definition of done, through the real interface: a member turns an
 * indexed document into a quiz and a flashcard deck, takes the quiz to a
 * server-scored completion screen with explanations and citations, flips and
 * grades cards to a session summary, and hits the honest failure and gating
 * states along the way.
 *
 * Every test signs up its own user: generation (10/min per room) and the
 * daily chat quota are per-user, and `fullyParallel` runs these beside the
 * rest of the suite. Indexing and generation both run on the mock provider —
 * one bounded step per POST — so no test ever waits on a real AI provider.
 *
 * Scoring is asserted by shape, not by exact number: the runner shuffles
 * options per attempt, so "which radio is correct" is not a stable selector.
 * What must hold is that a submission is scored on the server and the score
 * screen appears with the explanation and citation the server returned.
 */

/** Ingest and generate each run one bounded step per POST on the mock. */
const STEP_TIMEOUT = 30_000;

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

/** Answers the currently shown question with the first option, then advances. */
async function answerCurrentQuestion(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.getByRole("radio").first().check();
}

test("a member generates a quiz, takes it to a server-scored result, and retakes it", async ({
  page,
}) => {
  await signUpAndOnboard(page, "quiz-flow");
  const room = await createRoomViaUi(page, { label: "Quiz flow" });
  await seedRoomDocument(
    page,
    room.id,
    "Mechanics notes",
    "Rotational motion: torque equals the rate of change of angular momentum.",
  );

  // Entry link appears once a document is indexed.
  await page.goto(`/rooms/${room.id}`);
  const entry = page.getByRole("link", { name: "Quizzes & decks" });
  await expect(entry).toBeVisible();
  await entry.click();
  await page.waitForURL(new RegExp(`/rooms/${room.id}/generate`));
  await expect(
    page.getByRole("heading", { level: 1, name: "Quizzes & decks" }),
  ).toBeVisible();

  // Demo-mode banner: asserted together with the server's own word for it,
  // so a runner configured with a real key fails loudly instead of silently.
  const usage = await page.request.get("/api/ai/usage");
  expect(usage.status()).toBe(200);
  expect(((await usage.json()) as { provider: string }).provider).toBe("mock");
  await expect(page.getByTestId("generate-demo-banner")).toBeVisible();

  // Generate a short quiz. Length is set explicitly so the flow does not
  // depend on the form's default.
  await page.locator("#generate-count").selectOption("5");
  await page.getByTestId("generate-submit").click();
  await page.waitForURL(new RegExp(`/rooms/${room.id}/quizzes/`), {
    timeout: STEP_TIMEOUT,
  });
  await expect(page.getByRole("heading", { level: 1, name: "Quiz" })).toBeVisible();

  const runner = page.getByTestId("quiz-runner");
  await expect(runner).toBeVisible();
  await expect(page.getByTestId("quiz-progress")).toHaveText("0 / 5 answered");

  // The answer key must not be in the DOM before submit: the mock's first
  // question is true/false with correct_index 0, and no element may say so.
  await expect(page.getByText(/correct answer:/i)).toHaveCount(0);

  // Walk all five questions. The Next control appears until the last one,
  // where Submit answers takes over.
  for (let index = 0; index < 5; index += 1) {
    await answerCurrentQuestion(page);
    if (index < 4) {
      await page.getByTestId("quiz-next").click();
    }
  }
  await expect(page.getByTestId("quiz-submit")).toBeEnabled();
  await page.getByTestId("quiz-submit").click();

  // Server-scored completion screen: a score, the explanation and a citation
  // the server returned — not anything the client computed.
  const result = page.getByTestId("quiz-result");
  await expect(result).toBeVisible({ timeout: STEP_TIMEOUT });
  await expect(page.getByTestId("quiz-score")).toContainText("Score:");
  await expect(page.getByTestId("quiz-score")).toContainText("/ 5");
  await expect(result).toContainText("Demo mode:", { timeout: STEP_TIMEOUT });
  // Every question carries its own citation link to the same source, so the
  // locator is scoped to one question rather than the whole result list.
  await expect(
    result.getByRole("listitem").first().getByRole("link", { name: /\[1\] Mechanics notes/ }),
  ).toBeVisible();

  // Retake returns to a fresh runner at question 1 with a reset progress bar.
  await page.getByTestId("quiz-retake").click();
  await expect(page.getByTestId("quiz-runner")).toBeVisible();
  await expect(page.getByTestId("quiz-progress")).toHaveText("0 / 5 answered");
  await expect(page.getByText("Question 1 of 5")).toBeVisible();
});

test("a member generates flashcards, flips and grades to a session summary", async ({
  page,
}) => {
  await signUpAndOnboard(page, "deck-flow");
  const room = await createRoomViaUi(page, { label: "Deck flow" });
  await seedRoomDocument(
    page,
    room.id,
    "Waves notes",
    "Wave speed equals frequency times wavelength. Interference produces fringes.",
  );

  await page.goto(`/rooms/${room.id}/generate`);
  await page.locator("#generate-mode").selectOption("flashcards");
  await page.locator("#generate-count").selectOption("10");
  await page.getByTestId("generate-submit").click();
  await page.waitForURL(new RegExp(`/rooms/${room.id}/decks/`), {
    timeout: STEP_TIMEOUT,
  });
  await expect(
    page.getByRole("heading", { level: 1, name: "Flashcards" }),
  ).toBeVisible();

  const deck = page.getByTestId("flashcard-deck");
  await expect(deck).toBeVisible();
  await expect(page.getByTestId("deck-position")).toHaveText("Card 1 of 10");
  await expect(page.getByTestId("deck-due-count")).toHaveText("10 due");

  // Grading controls exist only after a flip — nothing is graded blind.
  await expect(page.getByTestId("flashcard-got-it")).toHaveCount(0);
  const flip = page.getByTestId("flashcard-flip");
  await expect(flip).toHaveAttribute("aria-pressed", "false");
  await flip.click();
  await expect(flip).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("flashcard-text")).toContainText("Demo mode: back of card 1");

  // First card "Got it" (schedules it days out): the due count drops by one
  // and the session advances.
  await page.getByTestId("flashcard-got-it").click();
  await expect(page.getByTestId("deck-position")).toHaveText("Card 2 of 10");
  await expect(page.getByTestId("deck-due-count")).toHaveText("9 due");

  // Walk the remaining nine, flipping and grading each as "Got it", to the
  // summary. Each grade resets the flip, so every card needs its own flip.
  for (let card = 2; card <= 10; card += 1) {
    await expect(page.getByTestId("flashcard-flip")).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("flashcard-flip").click();
    await page.getByTestId("flashcard-got-it").click();
  }
  const summary = page.getByTestId("deck-session-done");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("You graded 10 cards.");
});

test("a room without an indexed document disables-and-explains instead of hiding the entry", async ({
  page,
}) => {
  await signUpAndOnboard(page, "generate-empty");
  const room = await createRoomViaUi(page, { label: "Generate empty" });

  await page.goto(`/rooms/${room.id}`);
  const entry = page.getByRole("button", { name: /Quizzes and decks/ });
  await expect(entry).toBeVisible();
  await expect(entry).toBeDisabled();
  await expect(entry).toHaveAttribute(
    "title",
    "Index at least one document in Resources first.",
  );

  // Typing the URL anyway lands on an explanatory empty state, not a crash.
  await page.goto(`/rooms/${room.id}/generate`);
  await expect(page.getByTestId("generate-empty")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Nothing to generate from yet" }),
  ).toBeVisible();
  await expect(
    page.getByText("Upload a document to Resources", { exact: false }),
  ).toBeVisible();
});

test("a non-member gets the same 404 for the generate page as for a missing room", async ({
  page,
}) => {
  await signUpAndOnboard(page, "generate-owner");
  const room = await createRoomViaUi(page, { label: "Generate owned" });

  // A second visitor, signed in but not a member of that room. Manual
  // contexts do not inherit the fixture's baseURL, so it is passed along.
  const browser = page.context().browser();
  if (!browser) throw new Error("browser unavailable");
  const strangerContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const stranger = await strangerContext.newPage();
  await signUpAndOnboard(stranger, "generate-stranger");

  // The repo convention asserts the rendered 404 rather than the HTTP status,
  // because the app shell can flush before a notFound() settles.
  await stranger.goto(`/rooms/${room.id}/generate`);
  await expect(
    stranger.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();

  // The API agrees: 404 for a non-member, identical to a missing room.
  const missing = await stranger.request.get(
    "/api/rooms/99999999-9999-4999-8999-999999999999/artifacts",
  );
  expect(missing.status()).toBe(404);
  const nonMember = await stranger.request.get(
    `/api/rooms/${room.id}/artifacts`,
  );
  expect(nonMember.status()).toBe(404);

  await strangerContext.close();
});
