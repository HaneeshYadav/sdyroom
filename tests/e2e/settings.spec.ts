import { expect, test, type Page } from "@playwright/test";
import { createRoomViaUi } from "./helpers/rooms";
import { signUpAndOnboard, waitForHydration } from "./helpers/users";

/**
 * PR 20: settings end to end. The student edits their alias, exam targets
 * and language; the header and the roster reflect the new alias after a
 * refresh (no manual reload); a notification preference set here — through
 * PR 11's form, absorbed unchanged — survives a reload; invalid input never
 * claims success; and sign-out from the account section lands on the login
 * screen with the authenticated route-group guarded afterwards.
 *
 * The mobile-viewport reflow item from the spec is deferred with PR 19
 * (the shell it reflows against has not merged).
 */

async function openSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await waitForHydration(page, "#settings-alias");
}

/** Globally unique, within the alias length cap. */
function freshAlias(): string {
  return `sdyset${Date.now().toString(36)}`;
}

/**
 * The input's `maxLength` truncates a plain `fill()` to 32 characters, so
 * the over-length path can only be reached the way a hostile DOM or a stray
 * autofill would reach it: set the value past the cap and emit the input
 * event React listens to.
 */
async function forceOverlongAlias(page: Page): Promise<void> {
  await page.getByLabel("Study alias").evaluate((element) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, "x".repeat(33));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("edit alias, targets and language; header and roster reflect the change", async ({
  page,
}) => {
  await signUpAndOnboard(page, "settings");
  const room = await createRoomViaUi(page, { label: "settings" });

  // Reach settings through the shared, session-gated nav link. `exact`:
  // the room card just created contains "settings" in its name too.
  await page.goto("/rooms");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.waitForURL(/\/settings$/);
  await waitForHydration(page, "#settings-alias");

  const newAlias = freshAlias();

  await page.getByLabel("Study alias").fill(newAlias);
  await page.getByRole("button", { name: "Save alias" }).click();
  await expect(
    page.getByText(
      "Saved. Classmates will see the new alias in room rosters.",
    ),
  ).toBeVisible();

  // The header account control re-renders through router.refresh() — no
  // manual reload of the page.
  await expect(page.getByText(`Hey, ${newAlias}!`)).toBeVisible();

  await page.getByRole("checkbox", { name: "NEET" }).check();
  await page.getByLabel("Preferred language").selectOption("Hinglish");
  await page.getByRole("button", { name: "Save study details" }).click();
  await expect(
    page.getByText("Exam targets and language saved."),
  ).toBeVisible();

  // Roster: the alias is read live from profiles, so the workspace shows it
  // on the next render.
  await page.goto(`/rooms/${room.id}`);
  const roster = page.getByRole("region", { name: "Members" });
  await expect(roster.getByText(newAlias)).toBeVisible();

  // And the settings read-back persists everything.
  await openSettings(page);
  await expect(page.getByLabel("Study alias")).toHaveValue(newAlias);
  await expect(page.getByRole("checkbox", { name: "NEET" })).toBeChecked();
  await expect(page.getByLabel("Preferred language")).toHaveValue("Hinglish");
});

test("a notification preference change persists across a reload", async ({
  page,
}) => {
  await signUpAndOnboard(page, "settings-notif");
  await openSettings(page);

  // PR 11's form, mounted unchanged on settings — one endpoint, one state.
  await page.getByLabel("Invitations").selectOption("none");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByTestId("prefs-status")).toHaveText(
    "Preferences saved.",
  );

  await page.reload();
  await waitForHydration(page, "#settings-alias");
  await expect(page.getByLabel("Invitations")).toHaveValue("none");
});

test("an invalid alias shows an inline alert and never claims success", async ({
  page,
}) => {
  await signUpAndOnboard(page, "settings-invalid");
  await openSettings(page);

  await page.getByLabel("Study alias").fill("");
  await page.getByRole("button", { name: "Save alias" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Study alias is required" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Saved. Classmates will see the new alias in room rosters.",
    ),
  ).toBeHidden();

  await forceOverlongAlias(page);
  await page.getByRole("button", { name: "Save alias" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Study alias must be 32 characters or fewer" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Saved. Classmates will see the new alias in room rosters.",
    ),
  ).toBeHidden();
});

test("sign-out from the account section lands on login and guards the app", async ({
  page,
}) => {
  const user = await signUpAndOnboard(page, "settings-signout");
  await openSettings(page);

  const account = page.getByRole("region", { name: "Account" });
  await expect(account.getByLabel("Email")).toHaveValue(user.email);
  await expect(account.getByLabel("Email")).toHaveAttribute("readonly", "");

  await account.getByRole("button", { name: "Logout" }).click();
  await page.waitForURL(/\/auth\/login/);

  // The proxy guard redirects an anonymous session away from (app) routes.
  await page.goto("/settings");
  await page.waitForURL(/\/auth\/login/);
  expect(page.url()).toContain("/auth/login");
});
