import { expect, test, type Page } from "@playwright/test";

/**
 * Filters alone search, as Slack's do: `from:@vent` with no words lists every message from Vent, newest first. has:, is:, on: and during:
 * become chips instead of words, a search with no hits offers to search everywhere or drop the filters, and the results page has Channels
 * and People tabs beside Messages.
 */
const mod = process.platform === "darwin" ? "Meta" : "Control";

const palette = (page: Page) => page.locator("[data-search-palette]");
const field = (page: Page) => palette(page).getByRole("combobox");
const bar = (page: Page) => palette(page).locator("[data-search-filters]");
const count = (page: Page) => palette(page).getByTestId("search-count");
const messages = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "message" : "messages"}`;

async function total(page: Page, params: Record<string, string>): Promise<number> {
  const response = await page.request.get(`/api/search?${new URLSearchParams({ limit: "1", ...params })}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { total: number }).total;
}

const asked = (page: Page, check: (params: URLSearchParams) => boolean) =>
  page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === "/api/search" && !url.searchParams.has("cursor") && check(url.searchParams);
  });

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
});

test("from: alone lists every message from that agent, newest first, and the sort says so", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  const sent = asked(page, params => params.get("from") === "ag_vent" && !params.get("q") && params.get("sort") === "recent");
  await field(page).fill("from:vent ");
  await sent;
  await expect(field(page)).toHaveValue("");
  await expect(bar(page).locator("[data-chip=from]")).toHaveText("From: Vent");
  const all = await total(page, { from: "ag_vent" });
  expect(all).toBeGreaterThan(0);
  await expect(count(page)).toHaveText(messages(all));
  await expect(palette(page).locator("[data-key=see-all]")).toContainText("See all results");
  const sort = palette(page).locator("[data-search-sort]");
  await expect(sort).toHaveText("Most recent");
  await expect(sort).toBeDisabled();
  // Enter opens the full page with the filter and no words, which lists the same messages.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/search\?from=ag_vent$/);
  await expect(page.getByRole("heading", { name: "Search results" })).toBeVisible();
  await expect(page.getByTestId("results-count")).toHaveText(`${all.toLocaleString("en-US")} ${all === 1 ? "result" : "results"}`);
  await expect(page.locator("[data-result-card]").first()).toBeVisible();
});

test("has:, is:, on: and during: become chips, and has: prompts its choices", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("relay has:");
  await expect(palette(page).getByRole("group", { name: "Filters" }).getByRole("option")).toHaveText([/has:link/, /has:reaction/, /has:pin/]);
  const sent = asked(page, params => params.get("q") === "relay" && params.get("has") === "link,saved" && params.get("after") === "2026-11-01");
  await field(page).fill("relay has:link is:saved during:2026-11 ");
  await sent;
  await expect(field(page)).toHaveValue("relay ");
  await expect(bar(page).locator("[data-chip=has]")).toHaveText("Link +1");
  await expect(bar(page).locator("[data-chip=date]")).toHaveText("November");
  await bar(page).locator("[data-chip=has]").click();
  const menu = page.getByRole("menu", { name: "Has" });
  await expect(menu.getByRole("menuitemcheckbox", { name: /Has a link/ })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemcheckbox", { name: /^Saved/ })).toHaveAttribute("aria-checked", "true");
});

test("a search with no hits offers to search everywhere, then to drop the filters", async ({ page }) => {
  await page.goto("/#/c/ch_cutover");
  await page.getByRole("button", { name: "Channel actions" }).click();
  await page.getByRole("menuitem", { name: "Search in this conversation" }).click();
  await field(page).fill("from:me zzqqxxnothing");
  await expect(count(page)).toHaveText(messages(0));
  await expect(palette(page).getByRole("option").first()).toContainText("Search everywhere");
  await expect(palette(page).getByText("No messages match. Check the spelling")).toBeVisible();
  const wide = asked(page, params => params.get("q") === "zzqqxxnothing" && !params.get("in") && params.get("from") === "owner");
  await page.keyboard.press("Enter");
  await wide;
  await expect(bar(page).locator("[data-chip=in]")).toHaveText("In");
  await expect(palette(page).getByRole("option").first()).toContainText("Remove filters");
  await page.keyboard.press("Enter");
  await expect(bar(page).locator("[data-chip=from]")).toHaveText("From");
});

test("the results page's empty card drops the filters, and its tabs list channels and agents by name", async ({ page }) => {
  await page.goto("/#/search?q=zzqqxxnothing&from=owner");
  await expect(page.getByText("No results for “zzqqxxnothing”")).toBeVisible();
  await page.getByRole("button", { name: "Remove filters" }).click();
  await expect(page).toHaveURL(/#\/search\?q=zzqqxxnothing$/);

  await page.goto("/#/search?q=cut");
  const tabs = page.getByRole("tablist", { name: "Result types" });
  await tabs.getByRole("tab", { name: /Channels/ }).click();
  await expect(page).toHaveURL(/tab=channels/);
  await expect(page.locator("[data-search-channels]")).toContainText("pi-cutover");
  await expect(page.locator("[data-search-filters]")).toBeHidden();
  await page.goto("/#/search?q=ven&tab=people");
  await expect(page.locator("[data-search-people]")).toContainText("Vent");
  await page.locator("[data-search-people]").getByRole("link", { name: /^Vent/ }).first().click();
  await expect(page).toHaveURL(/#\/c\/dm_vent/);
});
