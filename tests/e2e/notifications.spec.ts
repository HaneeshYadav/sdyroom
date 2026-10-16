import { expect, test, type Page } from "@playwright/test";
import { createRoomViaUi } from "./helpers/rooms";
import { signUpAndOnboard, waitForHydration, type E2EUser } from "./helpers/users";

/**
 * The notification bell end to end (PR 11): an invite produced by the real
 * invitation route increments the invitee's badge in an open tab without a
 * manual reload, a click deep-links and decrements it, "Mark all read"
 * clears the badge durably, preferences suppress a *new* producer write at
 * the source, signed-out visitors never meet the bell, and the header
 * control stays usable at a phone viewport. The channel behind the live
 * update is proven separately in realtime.spec.ts; here the assertion is
 * the student-visible outcome.
 */

const PHONE = { width: 375, height: 812 };

function invitePanel(page: Page, roomId: string) {
  return page.getByRole("region", { name: "Invite a student" }).filter({
    has: page.locator(`#invite-alias-${roomId}`),
  });
}

async function sendInvitation(page: Page, roomId: string, alias: string) {
  const panel = invitePanel(page, roomId);
  await expect(panel.getByRole("heading", { name: "Invite a student" })).toBeVisible();
  await panel.locator(`#invite-alias-${roomId}`).fill(alias);
  await panel.getByRole("button", { name: "Send invitation" }).click();
  await expect(panel.getByText(`Invitation sent to ${alias}.`)).toBeVisible();
}

function bell(page: Page) {
  return page.getByTestId("notification-bell");
}

function badge(page: Page) {
  return page.getByTestId("notification-badge");
}

function aliasOf(user: E2EUser): string {
  if (!user.alias) {
    throw new Error(`No alias recorded for ${user.email}`);
  }
  return user.alias;
}

async function openBellDropdown(page: Page) {
  await bell(page).click();
  await expect(page.getByTestId("notification-panel")).toBeVisible();
}

/**
 * Converges on `expected` without a reload, and refuses to pass until both
 * truths agree — this is the assertion the deep-link and mark-all races hang
 * on, so it has to be harder to satisfy than the race it watches:
 *
 * 1. The server's unread count, read after the focus wakeup the tab already
 *    listens on. The badge alone cannot be trusted at this point: mark-read
 *    and mark-all decrement it optimistically, so immediately after a click
 *    the badge is *absent* while the server still counts the row unread — an
 *    absence-only check would pass before the write has even landed (it did;
 *    that false green is what let a cancelled mark-read reach the inbox
 *    assertion unnoticed).
 * 2. The badge itself, which must then reflect that count (absent at zero,
 *    the number otherwise). The wakeup's own refresh delivers the update; the
 *    expect retry window absorbs the round trip.
 */
async function expectBadge(page: Page, expected: number) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return page.evaluate(async () => {
          const response = await fetch("/api/notifications/unread-count", {
            cache: "no-store",
          });
          if (!response.ok) return -1;
          const body = (await response.json()) as { unread_count?: number };
          return typeof body.unread_count === "number" ? body.unread_count : -1;
        });
      },
      { timeout: 15_000, intervals: [250, 500, 1_000] },
    )
    .toBe(expected);

  if (expected === 0) {
    await expect(badge(page)).toHaveCount(0);
  } else {
    await expect(badge(page)).toHaveText(String(expected));
  }
}

test("live invite, deep link, mark-all, and preference suppression", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();

  try {
    await signUpAndOnboard(ownerPage, "notif-owner");
    const guest = await signUpAndOnboard(guestPage, "notif-guest");

    // Both tabs sit on discovery, bells mounted, while the owner invites
    // from a private workspace three separate times below.
    await guestPage.goto("/rooms");
    await expect(bell(guestPage)).toBeVisible();

    const firstRoom = await createRoomViaUi(ownerPage, {
      label: "notif-one",
      capacity: 3,
      visibility: "private",
    });
    await sendInvitation(ownerPage, firstRoom.id, aliasOf(guest));

    // The badge arrives in the already-open guest tab without a reload.
    await expectBadge(guestPage, 1);

    // Click-through: the dropdown row deep-links to /invitations, marks the
    // row read, and the badge decrements with it. The mark-read POST races
    // the navigation by design (the deep link never waits on it), so the
    // badge is converged through the wakeup — exactly how the product
    // re-syncs after a landing render that predated the write.
    await openBellDropdown(guestPage);
    const row = guestPage
      .getByTestId("notification-row")
      .filter({ hasText: firstRoom.name });
    await expect(row).toBeVisible();
    await row.click();
    await guestPage.waitForURL(/\/invitations$/);
    await expectBadge(guestPage, 0);

    // The read is durable: the inbox page lists the row as read.
    await guestPage.goto("/notifications");
    const readRow = guestPage
      .getByTestId("notification-row")
      .filter({ hasText: firstRoom.name });
    await expect(readRow).toBeVisible();
    await expect(readRow).toHaveAttribute("data-unread", "false");

    // Mark all read: a second invite raises the badge, then one click clears
    // it, and a fresh document still shows it cleared. The guest page was
    // just remounted by the goto above, so its live channel may still be
    // joining when the invite lands; expectBadge converges it without a
    // reload (server-side confirm + the focus wakeup the tab listens on).
    const secondRoom = await createRoomViaUi(ownerPage, {
      label: "notif-two",
      capacity: 3,
      visibility: "private",
    });
    await guestPage.goto("/rooms");
    await expect(bell(guestPage)).toBeVisible();
    await sendInvitation(ownerPage, secondRoom.id, aliasOf(guest));
    await expectBadge(guestPage, 1);
    await openBellDropdown(guestPage);
    await guestPage.getByTestId("notifications-mark-all").click();
    await expect(badge(guestPage)).toHaveCount(0);
    // Same POST-vs-navigation race as the click-through: the reload can
    // land before read-all finishes, so the badge converges via wakeup.
    await guestPage.reload();
    await expect(bell(guestPage)).toBeVisible();
    await expectBadge(guestPage, 0);

    // Preferences: the guest turns invitations off, the owner sends a third
    // invite through the same real producer, and nothing appears — no badge,
    // no list row — because the write was suppressed at the source.
    await guestPage.goto("/notifications");
    await waitForHydration(guestPage, "#pref-invite");
    await guestPage.locator("#pref-invite").selectOption("none");
    await guestPage.getByRole("button", { name: "Save preferences" }).click();
    await expect(guestPage.getByTestId("prefs-status")).toHaveText(
      "Preferences saved.",
    );

    const thirdRoom = await createRoomViaUi(ownerPage, {
      label: "notif-three",
      capacity: 3,
      visibility: "private",
    });
    await sendInvitation(ownerPage, thirdRoom.id, aliasOf(guest));

    await guestPage.reload();
    await expect(bell(guestPage)).toBeVisible();
    await expect(badge(guestPage)).toHaveCount(0);
    await expect(
      guestPage
        .getByTestId("notification-row")
        .filter({ hasText: thirdRoom.name }),
    ).toHaveCount(0);
    // The suppressed invite never becomes a row, while the earlier ones
    // remain listed and read.
    await expect(
      guestPage
        .getByTestId("notification-row")
        .filter({ hasText: secondRoom.name }),
    ).toBeVisible();
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});

test("a signed-out visitor never sees the bell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("notification-bell")).toHaveCount(0);
  await page.goto("/auth/login");
  await expect(page.getByTestId("notification-bell")).toHaveCount(0);
});

test.describe("phone viewport", () => {
  test.use({ viewport: PHONE });

  test("the bell is visible and its dropdown is operable", async ({ page }) => {
    const user = await signUpAndOnboard(page, "notif-phone");

    // The bell lives in the header itself, so it survives the md: collapse
    // that hides the inline nav and the account controls.
    await expect(bell(page)).toBeVisible();

    // An invite raises the badge at this width too — the owner invites from
    // a second browser the same way the desktop flow does.
    const ownerContext = await page.context().browser()!.newContext();
    const ownerPage = await ownerContext.newPage();
    try {
      await signUpAndOnboard(ownerPage, "notif-phone-owner");
      const room = await createRoomViaUi(ownerPage, {
        label: "notif-phone",
        capacity: 3,
        visibility: "private",
      });
      await sendInvitation(ownerPage, room.id, aliasOf(user));

      await expectBadge(page, 1);
      await openBellDropdown(page);
      const row = page
        .getByTestId("notification-row")
        .filter({ hasText: room.name });
      await expect(row).toBeVisible();
      await row.click();
      await page.waitForURL(/\/invitations$/);
      await expectBadge(page, 0);
    } finally {
      await ownerContext.close();
    }
  });
});
