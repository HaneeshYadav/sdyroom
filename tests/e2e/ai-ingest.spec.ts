import { expect, test } from "@playwright/test";
import { fixtureBytes, resourceRow, uploadViaUi } from "./helpers/resources";
import { signUpAndOnboard } from "./helpers/users";

/**
 * PR 12's definition of done, through the real interface: a freshly stored
 * file chips `Not indexed`, one explicit Index click walks the chip to
 * `Ready for AI`, a text-less PDF fails with honest copy instead of a fake
 * success, and the demo banner is present exactly when the server says the
 * mock provider is running.
 *
 * Demo-banner assertion choice (the PR lets us pick one and document it): the
 * banner itself is asserted via its `ai-demo-banner` testid, and the source of
 * truth for *why* it shows is `GET /api/ai/usage`'s `provider: "mock"` field —
 * both are checked together in the last test, so a runner configured with a
 * real key fails loudly instead of silently skipping demo mode.
 *
 * Every test signs up its own user: the ingest rate limit (30/min) and the
 * daily embed quota are per-user, and `fullyParallel` runs these beside the
 * rest of the suite.
 */

/** Indexing runs entirely on the mock provider — one bounded step per POST. */
const INDEX_TIMEOUT = 30_000;

test("a stored file chips Not indexed and reaches Ready for AI on Index", async ({
  page,
}) => {
  await signUpAndOnboard(page, "ai-index");

  // Stored through the API on purpose: the UI upload path auto-starts the
  // chain (covered by the next test), so this is the only way to observe the
  // rest state the spec pins — a row that chips `Not indexed` with a live
  // Index button waiting for its owner.
  const title = "Rotational motion — indexed by click";
  const uploaded = await page.request.post("/api/resources", {
    multipart: {
      file: {
        name: "rotational-motion.pdf",
        mimeType: "application/pdf",
        buffer: fixtureBytes("rotational-motion.pdf"),
      },
      title,
    },
  });
  expect(uploaded.status()).toBe(201);

  await page.goto("/resources");
  const chip = resourceRow(page, title).getByTestId("ai-status-chip");
  await expect(chip).toHaveText("Not indexed");

  await resourceRow(page, title)
    .getByRole("button", { name: `Index ${title} for AI` })
    .click();

  await expect(chip).toHaveText("Ready for AI", { timeout: INDEX_TIMEOUT });
  await expect(page.getByText(/is ready for AI/)).toBeVisible();

  // Reload: readiness is stored server-side, not a client-side illusion.
  await page.reload();
  await expect(chip).toHaveText("Ready for AI");
});

test("a UI upload auto-indexes to Ready for AI without another click", async ({
  page,
}) => {
  await signUpAndOnboard(page, "ai-autoindex");
  await page.goto("/resources");

  const title = "Rotational motion — auto indexed";
  await uploadViaUi(
    page,
    { kind: "personal" },
    {
      name: "rotational-motion.pdf",
      mimeType: "application/pdf",
      buffer: fixtureBytes("rotational-motion.pdf"),
    },
    title,
  );

  // `onUploaded` kicks the chain: the row should settle on its own.
  await expect(resourceRow(page, title).getByTestId("ai-status-chip")).toHaveText(
    "Ready for AI",
    { timeout: INDEX_TIMEOUT },
  );
});

test("an image-only PDF fails with the honest no-text-layer copy", async ({
  page,
}) => {
  await signUpAndOnboard(page, "ai-notext");
  await page.goto("/resources");

  const title = "Scanned page — no text layer";
  await uploadViaUi(
    page,
    { kind: "personal" },
    {
      name: "drawing-only.pdf",
      mimeType: "application/pdf",
      buffer: fixtureBytes("drawing-only.pdf"),
    },
    title,
  );

  const row = resourceRow(page, title);
  const chip = row.getByTestId("ai-status-chip");
  await expect(chip).toHaveText("Failed — no text layer", {
    timeout: INDEX_TIMEOUT,
  });
  await expect(page.getByText(/could not be indexed/)).toBeVisible();

  // The failure stays resumable: an owner-triggered retry re-runs extraction
  // and reports the same honest outcome — never a stuck "Indexing…".
  await row.getByRole("button", { name: `Index ${title} for AI` }).click();
  await expect(chip).toHaveText("Failed — no text layer", {
    timeout: INDEX_TIMEOUT,
  });
});

test("the demo banner shows exactly while the server reports the mock provider", async ({
  page,
}) => {
  await signUpAndOnboard(page, "ai-demo");

  const usage = await page.request.get("/api/ai/usage");
  expect(usage.status()).toBe(200);
  const body = await usage.json();
  expect(
    body.provider,
    "E2E runs the mock provider path — unset AI_API_KEY/AI_PROVIDER to run this suite",
  ).toBe("mock");

  await page.goto("/resources");
  const banner = page.getByTestId("ai-demo-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("demo mode");
});
