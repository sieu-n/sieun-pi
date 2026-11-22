import { expect, test, type Page } from "@playwright/test";
import { tag } from "../channel/helpers";
import { resetOwnerSettings } from "../shell/owner-settings";

/**
 * Cmd K as Slack's search box: one Esc closes it, it reopens on the last query or the results page's own with the text selected, and the
 * empty field lists recent searches to pick, remove one by one or clear, with Undo.
 */
const mod = process.platform === "darwin" ? "Meta" : "Control";

const palette = (page: Page) => page.locator("[data-search-palette]");
const field = (page: Page) => palette(page).getByRole("combobox");
const allRecent = (page: Page) => palette(page).locator("[role=group][aria-label='Recent searches'] [data-search-result]");
const selection = (page: Page) => field(page).evaluate(input => (input as HTMLInputElement).value.slice((input as HTMLInputElement).selectionStart ?? 0, (input as HTMLInputElement).selectionEnd ?? 0));

// Recent searches live on the one fixture server, and the results page adds each search it shows, so these tests take turns.
test.describe.configure({ mode: "serial" });
test.afterAll(({ request }) => resetOwnerSettings(request));

test.beforeEach(async ({ page }) => {
  await resetOwnerSettings(page.request);
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
  // Other specs' searches land in the same list meanwhile, so this one runs words of its own and looks at those rows only.
  const t = tag();
  const [RELAY, CANARY] = [`relay${t}`, `canary${t}`];
  const recent = (page: Page) => allRecent(page).filter({ hasText: new RegExp(`${RELAY}|${CANARY}`) });
  // Words of a run's own find no message, and Enter on an empty result list runs no search, so the results page runs them.
  for (const q of [RELAY, CANARY]) {
    await page.goto(`/#/search?q=${q}`);
    await expect(page.locator("[data-search-page]")).toBeVisible();
  }
  await page.goto("/#/c/ch_general");
  await page.keyboard.press(`${mod}+k`);
  await expect(field(page)).toHaveValue("");
  await expect(recent(page)).toHaveText([CANARY, RELAY]);

  await recent(page).nth(1).click();
  await expect(field(page)).toHaveValue(RELAY);
  await expect(field(page)).toBeFocused();
  await field(page).fill("");

  const canaryRow = palette(page).locator(".recall").filter({ hasText: CANARY });
  await canaryRow.hover();
  await canaryRow.getByRole("button", { name: "Remove from recent searches" }).click();
  await expect(recent(page)).toHaveText([RELAY]);
  await expect(palette(page).getByRole("status")).toHaveText(new RegExp(`Removed “${CANARY}” from recent searches\\.`));
  await palette(page).getByRole("button", { name: "Undo" }).click();
  await expect(recent(page)).toHaveText([CANARY, RELAY]);
  await expect(palette(page).getByRole("status")).toHaveCount(0);

  const canary = (await recent(page).first().getAttribute("id"))!;
  for (let i = 0; i < 4 && (await field(page).getAttribute("aria-activedescendant")) !== canary; i += 1) await page.keyboard.press("ArrowDown");
  await expect(field(page)).toHaveAttribute("aria-activedescendant", canary);
  await page.keyboard.press("Delete");
  await expect(recent(page)).toHaveText([RELAY]);

  await palette(page).getByRole("button", { name: "Clear all" }).click();
  await expect(recent(page)).toHaveCount(0);
  await expect(palette(page).getByRole("status")).toHaveText(/Cleared recent searches\./);
  await page.keyboard.press(`${mod}+z`);
  await expect(recent(page)).toHaveText([RELAY]);

  await page.reload();
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  await expect(recent(page)).toHaveText([RELAY]);
});
