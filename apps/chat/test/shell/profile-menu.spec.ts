import { expect, test, type Page } from "@playwright/test";

/** The profile menu sets a status, away and a notification pause; the interface size shows its percent; Back and Forward grey out at the ends. */

const profile = (page: Page) => page.locator("header.topbar button.profile");
const menu = (page: Page) => page.getByRole("menu", { name: "Profile" });

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/later");
  await expect(profile(page)).toBeVisible({ timeout: 20_000 });
});

test("Set a status from a suggestion, see it in the menu, then clear it with Undo", async ({ page }) => {
  await profile(page).click();
  await expect(menu(page)).toContainText("Active");
  await menu(page).getByRole("menuitem", { name: "Set a status" }).click();
  const dialog = page.getByRole("dialog", { name: "Set a status" });
  await dialog.getByRole("button", { name: /Out sick/ }).click();
  await expect(dialog.getByRole("textbox", { name: "Status" })).toHaveValue("Out sick");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(profile(page)).toHaveAttribute("aria-label", /🤒 Out sick/);

  await profile(page).click();
  await expect(menu(page)).toContainText("Out sick");
  await menu(page).getByRole("menuitem", { name: "Clear status" }).click();
  await expect(profile(page)).not.toHaveAttribute("aria-label", /Out sick/);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(profile(page)).toHaveAttribute("aria-label", /Out sick/);
  await page.reload();
  await expect(profile(page)).toHaveAttribute("aria-label", /Out sick/);
});

test("Away turns the avatar dot to away, and a pause shows until when", async ({ page }) => {
  await profile(page).click();
  await menu(page).getByRole("menuitem", { name: "Set yourself as away" }).click();
  await expect(profile(page)).toHaveAttribute("aria-label", /away/);
  await expect(profile(page).locator(".status.away")).toBeVisible();

  await profile(page).click();
  await menu(page).getByRole("menuitem", { name: "Pause notifications" }).click();
  await page.getByRole("menuitem", { name: "For 1 hour" }).click();
  await expect(page.getByText(/Notifications paused until/)).toBeVisible();
  await expect(profile(page)).toHaveAttribute("aria-label", /notifications paused/);
  await profile(page).click();
  await expect(menu(page)).toContainText("Away, notifications paused until");
  await menu(page).getByRole("menuitem", { name: "Pause notifications" }).click();
  await page.getByRole("menuitem", { name: "Resume notifications" }).click();
  await expect(profile(page)).not.toHaveAttribute("aria-label", /paused/);
});

test("Cmd+= shows the interface size in a toast with Reset, and the menu shows the percent", async ({ page }) => {
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("ControlOrMeta+=");
  await expect(page.getByText("Interface size 110%")).toBeVisible();
  await profile(page).click();
  await expect(menu(page).getByRole("menuitem", { name: /Interface size/ })).toContainText("110%");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByText("Interface size 100%")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.style.zoom)).toBe("");
});

test("Back and Forward grey out at the ends, and History lists the places opened", async ({ page }) => {
  const back = page.locator("header.topbar").getByRole("button", { name: "Back" });
  const forward = page.locator("header.topbar").getByRole("button", { name: "Forward" });
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();
  await page.evaluate(() => (location.hash = "#/c/for-you"));
  await expect(back).toBeEnabled();
  await back.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/c/later");
  await expect(back).toBeDisabled();
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(forward).toBeDisabled();

  await page.locator("header.topbar").getByRole("button", { name: "History" }).click();
  const history = page.getByRole("menu", { name: "History" });
  await history.getByRole("menuitem", { name: /Later/ }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/c/later");
});

test("At 110% in a 900 px window the History button stays clear of the capsule", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.evaluate(() => localStorage.setItem("chat.interfaceScale", "1.1"));
  await page.reload();
  const historyBox = await page.locator("header.topbar").getByRole("button", { name: "History" }).boundingBox();
  const capsuleBox = await page.getByTestId("nav-capsule").boundingBox();
  expect(historyBox && capsuleBox && historyBox.x + historyBox.width <= capsuleBox.x).toBe(true);
});
