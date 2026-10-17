import { expect, test, type Page } from "@playwright/test";
import { createRoomViaUi, roomCard, searchRooms, uniqueRoomName } from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";

/**
 * PR 17 — advanced room discovery, end to end: the URL is the state, the
 * list never shows a private room, and the preview page is safe to link.
 * Existing create/join/invite journeys that lean on discovery are covered
 * by student-workflow and room-management; this file owns the new surface.
 */

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 720 };

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    widths.scrollWidth,
    `expected no horizontal overflow (scrollWidth=${widths.scrollWidth}, clientWidth=${widths.clientWidth})`,
  ).toBeLessThanOrEqual(widths.clientWidth + 1);
}

test.describe("public discovery", () => {
  test("a public room is findable and its preview page decides before joining", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "disc-owner");
    const room = await createRoomViaUi(page, { label: "Findable", capacity: 6 });

    // A second student: same browser context would share the session, so a
    // fresh page is not enough — sign up again through a new context page.
    const strangerContext = await page.context().browser()!.newContext();
    const stranger = await strangerContext.newPage();
    try {
      await signUpAndOnboard(stranger, "disc-stranger");
      await searchRooms(stranger, room.name);

      const card = roomCard(stranger, room.name);
      await expect(card).toBeVisible();
      // create_room makes the owner a member, so the seat count starts at 1.
      await expect(card.getByText("1 of 6 seats taken")).toBeVisible();

      // The whole card links to the preview, not straight into the room.
      await card.getByRole("link", { name: room.name }).click();
      await stranger.waitForURL(new RegExp(`/rooms/${room.id}/preview`));
      await expect(
        stranger.getByRole("heading", { level: 1, name: room.name }),
      ).toBeVisible();
      // Exact: the nav link "Public rooms" also contains the word.
      await expect(stranger.getByText("Public", { exact: true })).toBeVisible();
      // The preview's Seats row is a definition list; the browse card's seat
      // label is a span that can linger in the DOM during the transition,
      // so the `dd` role pins the assertion to the preview page itself.
      await expect(
        stranger.getByRole("definition").filter({ hasText: "of 6 seats taken" }),
      ).toBeVisible();

      // Join from the preview, then enter.
      await stranger
        .getByRole("button", { name: `Join ${room.name}` })
        .click();
      await expect(
        stranger.getByRole("link", { name: "Open room" }),
      ).toBeVisible();
      await stranger.getByRole("link", { name: "Open room" }).click();
      await stranger.waitForURL(new RegExp(`/rooms/${room.id}$`));
      await expect(
        stranger.getByRole("heading", { level: 1, name: room.name }),
      ).toBeVisible();

      // The owner sees "own this room" on the preview, never a Join button.
      await page.goto(`/rooms/${room.id}/preview`);
      await expect(page.getByText("You own this room.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Open room" })).toBeVisible();
    } finally {
      await strangerContext.close();
    }
  });

  test("a private room is invisible to discovery and its preview is not found", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "disc-priv");
    const room = await createRoomViaUi(page, {
      label: "Unlisted",
      visibility: "private",
    });

    // Not in discovery even for the owner searching the exact name.
    await searchRooms(page, room.name);
    await expect(page.getByText("No public rooms match your search.")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: room.name }),
    ).toHaveCount(0);

    // The owner previews their own private room...
    await page.goto(`/rooms/${room.id}/preview`);
    await expect(
      page.getByRole("heading", { level: 1, name: room.name }),
    ).toBeVisible();

    // ...but a stranger gets the same not-found a missing uuid gets.
    const strangerContext = await page.context().browser()!.newContext();
    const stranger = await strangerContext.newPage();
    try {
      await signUpAndOnboard(stranger, "disc-priv-out");
      await stranger.goto(`/rooms/${room.id}/preview`);
      await expect(
        stranger.getByRole("heading", { name: "Page not found" }),
      ).toBeVisible();
    } finally {
      await strangerContext.close();
    }
  });

  test("search debounces into the URL and keeps the other filters", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "disc-search");
    const room = await createRoomViaUi(page, { label: "Biology" });

    await page.goto("/rooms");
    await page.locator("#room-search").fill(room.name);
    // The debounced replace lands the query in the URL without a submit.
    await expect(page).toHaveURL(/\?q=/);
    await expect(roomCard(page, room.name)).toBeVisible();

    // A filter on top of the query survives in the URL together.
    await page.locator("#filter-sort").selectOption("recent");
    await expect(page).toHaveURL(/q=/);
    await expect(page).toHaveURL(/sort=recent/);
  });

  test("a filtered URL restores the exact state, chips included", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "disc-url");
    const subject = `Subj${Date.now().toString(36)}`;
    const room = await createRoomViaUi(page, { label: "Filtered", subject });

    await page.goto(`/rooms?subject=${encodeURIComponent(subject)}`);
    await expect(page.getByText(`Subject: ${subject}`)).toBeVisible();
    await expect(page.locator("#filter-subject")).toHaveValue(subject);
    await expect(roomCard(page, room.name, subject)).toBeVisible();

    // The chip removes exactly that filter.
    await page
      .getByRole("button", { name: `Remove filter Subject: ${subject}` })
      .click();
    await expect(page).not.toHaveURL(/subject=/);
    await expect(page.getByText(`Subject: ${subject}`)).toHaveCount(0);
  });

  test("an invalid query explains itself instead of guessing", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "disc-invalid");
    await page.goto("/rooms?sort=bogus");

    // The alert carries the explanation; the list renders the safe empty
    // state rather than guessing at what the visitor meant. Next's route
    // announcer is also an alert, so match the validation copy, not the role.
    await expect(page.getByText(/Invalid option/)).toBeVisible();
    await expect(page.getByText("No public rooms yet. Create the first one.")).toBeVisible();
  });

  test("the empty state offers a clear and a way out", async ({ page }) => {
    await signUpAndOnboard(page, "disc-empty");
    await page.goto(`/rooms?q=${uniqueRoomName("Nothing")}`);

    await expect(
      page.getByText("No public rooms match your search."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(page.getByRole("link", { name: "Create a room" })).toBeVisible();
  });

  test("load more pages through the cursor without repeating a room", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "disc-page");
    const subject = `Page${Date.now().toString(36)}`;
    const first = await createRoomViaUi(page, { label: "PageOne", subject });
    const second = await createRoomViaUi(page, { label: "PageTwo", subject });

    // limit=1 forces a second page with only the two fixtures in scope.
    // Newest-first means the later room lands on page one; which one it is
    // must not matter, so only the counts and the union are asserted.
    await page.goto(`/rooms?subject=${encodeURIComponent(subject)}&limit=1`);
    await expect(page.getByRole("listitem")).toHaveCount(1);
    const loadMore = page.getByRole("button", { name: "Load more rooms" });
    await expect(loadMore).toBeVisible();

    await loadMore.click();
    await expect(page.getByRole("listitem")).toHaveCount(2);
    await expect(roomCard(page, first.name, subject)).toBeVisible();
    await expect(roomCard(page, second.name, subject)).toBeVisible();
    await expect(loadMore).toHaveCount(0);
  });
});

test.describe("discovery on a phone", () => {
  test.use({ viewport: PHONE });

  test("search, filters and results fit without horizontal overflow", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "disc-phone");
    const room = await createRoomViaUi(page, { label: "PhoneFit" });

    await page.goto(`/rooms?q=${encodeURIComponent(room.name)}`);
    await expect(roomCard(page, room.name)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.locator("#filter-subject").scrollIntoViewIfNeeded();
    await expect(page.locator("#filter-subject")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto(`/rooms/${room.id}/preview`);
    await expect(
      page.getByRole("heading", { level: 1, name: room.name }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("discovery on a desktop", () => {
  test.use({ viewport: DESKTOP });

  test("filters, chips and the results grid fit the viewport", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "disc-desktop");
    const room = await createRoomViaUi(page, { label: "DesktopFit" });

    await page.goto(`/rooms?q=${encodeURIComponent(room.name)}&sort=name`);
    await expect(roomCard(page, room.name)).toBeVisible();
    await expect(page.getByText("Sorted by name")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
