import { expect, test, type Page } from "@playwright/test";

/**
 * Cmd K as Slack's search box: one Esc closes it, it reopens on the last query or the results page's own with the text selected, and the
 * empty field lists recent searches to pick, remove one by one or clear, with Undo.
 */
const mod = process.platform === "darwin" ? "Meta" : "Control";

const palette = (page: Page) => page.locator("[data-search-palette]");
const field = (page: Page) => palette(page).getByRole("combobox");
const recent = (page: Page) => palette(page).locator("[role=group][aria-label='Recent searches'] [data-search-result]");
const selection = (page: Page) => field(page).evaluate(input => (input as HTMLInputElement).value.slice((input as HTMLInputElement).selectionStart ?? 0, (input as HTMLInputElement).selectionEnd ?? 0));

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
});

test("one Esc closes Cmd K with text typed", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("relay");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
});

test("Cmd K reopens on the query it closed on, selected, so typing replaces it", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("relay");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(field(page)).toHaveValue("relay");
  await expect.poll(() => selection(page)).toBe("relay");
  await page.keyboard.type("canary");
  await expect(field(page)).toHaveValue("canary");
});

test("the results page's Search pill opens on that page's query and filters", async ({ page }) => {
  await page.goto("/#/search?q=relay&from=owner");
  await expect(page.locator("[data-search-page]")).toBeVisible();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(field(page)).toHaveValue("relay");
  await expect.poll(() => selection(page)).toBe("relay");
  await expect(palette(page).locator("[data-search-filters] [data-chip=from]")).toContainText("From: ");
});

test("a search run lands in Recent searches; a pick fills the field; x, Delete and Clear all remove them with Undo", async ({ page }) => {
  for (const q of ["relay", "canary"]) {
    await page.keyboard.press(`${mod}+k`);
    await field(page).fill(q);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`#/search\\?q=${q}`));
  }
  await page.goto("/#/c/ch_general");
  await page.keyboard.press(`${mod}+k`);
  await expect(field(page)).toHaveValue("");
  await expect(recent(page)).toHaveText(["canary", "relay"]);

  await recent(page).nth(1).click();
  await expect(field(page)).toHaveValue("relay");
  await expect(field(page)).toBeFocused();
  await field(page).fill("");

  await recent(page).first().hover();
  await palette(page).getByRole("button", { name: "Remove from recent searches" }).first().click();
  await expect(recent(page)).toHaveText(["relay"]);
  await expect(palette(page).getByRole("status")).toHaveText(/Removed “canary” from recent searches\./);
  await palette(page).getByRole("button", { name: "Undo" }).click();
  await expect(recent(page)).toHaveText(["canary", "relay"]);
  await expect(palette(page).getByRole("status")).toHaveCount(0);

  const canary = (await recent(page).first().getAttribute("id"))!;
  for (let i = 0; i < 4 && (await field(page).getAttribute("aria-activedescendant")) !== canary; i += 1) await page.keyboard.press("ArrowDown");
  await expect(field(page)).toHaveAttribute("aria-activedescendant", canary);
  await page.keyboard.press("Delete");
  await expect(recent(page)).toHaveText(["relay"]);

  await palette(page).getByRole("button", { name: "Clear all" }).click();
  await expect(recent(page)).toHaveCount(0);
  await expect(palette(page).getByRole("status")).toHaveText(/Cleared recent searches\./);
  await page.keyboard.press(`${mod}+z`);
  await expect(recent(page)).toHaveText(["relay"]);

  await page.reload();
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  await expect(recent(page)).toHaveText(["relay"]);
});
