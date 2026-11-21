import { HARNESS, HARNESS_AGENT, expect, resetFixture, test } from "./helpers";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request, chatServer }) => { await resetFixture(request, chatServer); });

test("a board hides from All boards and the sidebar with Undo, and the list menu shows hidden boards again", async ({ page }) => {
  await page.goto("/#/board");
  const plans = page.getByRole("region", { name: "Plans" });
  await expect(plans.locator("li")).toHaveCount(3);
  await plans.locator(`a[data-chat="${HARNESS_AGENT}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide board" }).click();
  await expect(plans.locator("li")).toHaveCount(2);
  await expect(page.locator(`[data-sidebar-row][href="#/board/${HARNESS_AGENT}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(plans.locator("li")).toHaveCount(3);

  await plans.locator(`a[data-chat="${HARNESS_AGENT}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide board" }).click();
  await expect(plans.locator("li")).toHaveCount(2);
  await page.reload();
  await expect(plans.locator("li")).toHaveCount(2);
  await page.getByRole("button", { name: "Board list options" }).click();
  await page.getByRole("menuitemcheckbox", { name: /Show hidden boards/ }).click();
  await expect(plans.locator("li")).toHaveCount(3);
  await expect(plans.locator("li.hidden-board")).toContainText("Hidden");
  await plans.locator("li.hidden-board").getByRole("button", { name: /options$/ }).click();
  await page.getByRole("menuitem", { name: "Show board" }).click();
  await expect(plans.locator("li.hidden-board")).toHaveCount(0);
});

test("the check-in menu takes a custom interval and a pause until a picked date and time", async ({ page }) => {
  await page.goto(`/#/board/${HARNESS}`);
  const checkIn = page.getByRole("region", { name: "Check-in" });
  const settings = checkIn.getByRole("button", { name: "Check-in settings" });
  await settings.click();
  await expect(page.getByRole("menuitemradio", { name: "daily" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Custom…" }).click();
  const dialog = page.getByRole("dialog", { name: "Check in every" });
  await dialog.getByRole("spinbutton", { name: "How many" }).fill("3");
  await dialog.getByRole("combobox", { name: "Unit" }).selectOption("hours");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(settings).toHaveText(/Check-in 3h/);
  await expect(checkIn).toContainText("Check-in every 180 min");

  await settings.click();
  await page.getByRole("menuitem", { name: "Pause until…" }).click();
  const pause = page.getByRole("dialog", { name: "Pause check-ins until" });
  await pause.getByLabel("Date").fill("2099-01-02");
  await pause.getByLabel("Time").fill("14:30");
  await pause.getByRole("button", { name: "Save" }).click();
  await expect(checkIn).toContainText("Check-in paused until Jan 2, 2099 14:30");
  await expect(settings).toHaveText(/Paused until Jan 2, 2099/);
});

test("Find and Filter cut a plan to the matching steps, keep the path above each, and say when nothing matches", async ({ page }) => {
  await page.goto(`/#/board/${HARNESS}`);
  const plan = page.getByRole("region", { name: "Plan" });
  await plan.getByRole("button", { name: "Find" }).click();
  await page.getByRole("textbox", { name: "Find steps" }).fill("relay");
  await expect(plan).toContainText("3 of 7");
  for (const id of ["p1", "p2", "p5", "p6"]) await expect(page.locator(`[data-step="${id}"]`)).toBeVisible();
  for (const id of ["p3", "p4", "p7"]) await expect(page.locator(`[data-step="${id}"]`)).toHaveCount(0);
  await expect(page.locator('[data-step="p1"]')).toHaveClass(/context/);
  await page.getByRole("textbox", { name: "Find steps" }).press("Escape");
  await expect(page.getByRole("textbox", { name: "Find steps" })).toHaveCount(0);
  await expect(page.locator('[data-step="p7"]')).toBeVisible();

  await plan.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: /Needs your go/ })).toBeDisabled();
  await page.getByRole("menuitemcheckbox", { name: "Blocked" }).click();
  await page.keyboard.press("Escape");
  await expect(plan.getByRole("button", { name: "Filter 1" })).toBeVisible();
  await expect(plan).toContainText("1 of 7");
  await expect(page.locator('[data-step="p5"]')).toBeVisible();
  await expect(page.locator('[data-step="p2"]')).toHaveCount(0);

  await plan.getByRole("button", { name: "Find" }).click();
  await page.getByRole("textbox", { name: "Find steps" }).fill("cutover");
  await expect(plan).toContainText("No steps match");
  await plan.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator('[data-step="p7"]')).toBeVisible();
  await expect(plan.getByRole("button", { name: "Filter", exact: true })).toBeVisible();
});
