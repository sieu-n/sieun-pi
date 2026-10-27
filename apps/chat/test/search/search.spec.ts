import { expect, test, type Page } from "@playwright/test";

/**
 * Cmd K and Cmd F search against the chat server's fixture: groups, operators as chips, keyboard moves, exact counts
 * and opening a hit at its message.
 */
const mod = process.platform === "darwin" ? "Meta" : "Control";

const palette = (page: Page) => page.locator("[data-search-palette]");
const field = (page: Page) => palette(page).getByRole("combobox");
const groupNames = (page: Page) => palette(page).locator("[role=group]").evaluateAll(groups => groups.map(g => g.getAttribute("aria-label")));
const count = (page: Page) => palette(page).getByTestId("search-count");

async function total(page: Page, params: Record<string, string>): Promise<number> {
  const response = await page.request.get(`/api/search?${new URLSearchParams({ limit: "1", ...params })}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { total: number }).total;
}

const messages = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "message" : "messages"}`;

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
});

test("Cmd K opens on this conversation and recent activity, and Esc closes it", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await expect(field(page)).toBeFocused();
  expect(await groupNames(page)).toEqual(["This conversation", "Recent activity"]);
  await expect(palette(page).locator("[role=group][aria-label='Recent activity'] [data-search-result]")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
});

test("text shows named groups before messages, with an exact count and underlined matches", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("relay");
  await expect(count(page)).toHaveText(messages(await total(page, { q: "relay" })));
  const names = await groupNames(page);
  expect(names.at(-1)).toBe("Most relevant");
  expect(names.indexOf("Chats")).toBeLessThan(names.indexOf("Most relevant"));
  expect(names.indexOf("Agents")).toBeLessThan(names.indexOf("Most relevant"));
  const marks = await palette(page).locator("[role=group][aria-label='Most relevant'] mark").allInnerTexts();
  expect(marks.length).toBeGreaterThan(0);
  for (const mark of marks) expect(mark.toLowerCase()).toBe("relay");
});

test("from: picks an author as a chip, the count follows it, and Backspace removes it", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).pressSequentially("relay from:own");
  await expect(palette(page).locator("[role=group][aria-label='People'] [data-search-result]")).toHaveCount(1);
  await page.keyboard.press("Enter");
  const chip = palette(page).locator(".prefix .chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("from:@");
  await expect(field(page)).toHaveValue("relay ");
  await expect(count(page)).toHaveText(messages(await total(page, { q: "relay", from: "owner" })));
  await field(page).press("Home");
  await field(page).press("Backspace");
  await expect(chip).toHaveCount(0);
  await expect(count(page)).toHaveText(messages(await total(page, { q: "relay" })));
});

test("a typed operator becomes a chip once it is complete, and its x removes it", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).pressSequentially("in:pi-cutover relay");
  const chip = palette(page).locator(".prefix .chip");
  await expect(chip).toContainText("in:#pi-cutover");
  await expect(field(page)).toHaveValue("relay");
  await expect(count(page)).toHaveText(messages(await total(page, { q: "relay", in: "ch_cutover" })));
  await chip.getByRole("button", { name: /Remove/ }).click();
  await expect(chip).toHaveCount(0);
  await expect(field(page)).toBeFocused();
});

test("after: offers date presets, and a bad date stays as text", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).pressSequentially("canary after:");
  const dates = palette(page).locator("[role=group][aria-label='Dates'] [data-search-result]");
  await expect(dates).toHaveCount(5);
  await expect(dates.first()).toContainText("Today");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const chip = palette(page).locator(".prefix .chip");
  await expect(chip).toContainText(/after:\d{4}-\d{2}-\d{2}/);
  const date = (await chip.innerText()).match(/\d{4}-\d{2}-\d{2}/)![0];
  await expect(count(page)).toHaveText(messages(await total(page, { q: "canary", after: date })));
  await field(page).fill("canary before:2026-02-30 ");
  await expect(chip).toHaveCount(1);
  await expect(field(page)).toHaveValue("canary before:2026-02-30 ");
});

test("arrow keys move the highlight, Enter opens the hit at its message", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("migration");
  const hits = palette(page).locator("[role=group][aria-label='Most relevant'] [data-search-result]");
  await expect(hits.first()).toBeVisible();
  const first = await palette(page).locator("[data-search-result]").first().getAttribute("id");
  await expect(field(page)).toHaveAttribute("aria-activedescendant", first!);
  const rows = await palette(page).locator("[data-search-result]").count();
  const index = rows - (await hits.count());
  for (let i = 0; i < index; i += 1) await page.keyboard.press("ArrowDown");
  await expect(field(page)).toHaveAttribute("aria-activedescendant", (await hits.first().getAttribute("id"))!);
  const response = await page.request.get(`/api/search?q=migration&limit=1`);
  const hit = ((await response.json()) as { hits: { conversation: { id: string }; messageId: string }[] }).hits[0]!;
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`#/c/${hit.conversation.id}\\?m=${hit.messageId}$`));
});

test("a hit opens the conversation scrolled to that message with a flash", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("relay");
  const hit = palette(page).locator("[role=group][aria-label='Most relevant'] [data-search-result]").first();
  await hit.click();
  const id = new URL(page.url().replace("#/", "")).searchParams.get("m");
  expect(id).toBeTruthy();
  const message = page.locator(`[data-message-id="${id}"]`);
  await expect(message).toBeInViewport();
  await expect(message).toHaveAttribute("data-flash", /.*/);
});

test("Cmd F scopes search to this conversation, sorts, and the scope chip removes the scope", async ({ page }) => {
  await page.goto("/#/c/ch_cutover");
  await page.keyboard.press(`${mod}+f`);
  await expect(page.getByRole("dialog", { name: "Search this conversation" })).toBeVisible();
  await field(page).fill("relay");
  await expect(count(page)).toHaveText(messages(await total(page, { q: "relay", in: "ch_cutover" })));
  expect(await groupNames(page)).toEqual(["Most relevant"]);
  await page.getByRole("button", { name: "Sort messages" }).click();
  await page.getByRole("menuitemradio", { name: "Most recent" }).click();
  expect(await groupNames(page)).toEqual(["Most recent"]);
  await palette(page).getByRole("button", { name: /search scope/ }).click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  expect(await groupNames(page)).toContain("Channels");
});

test("Show more pages through every hit up to the exact count", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("canary");
  const all = await total(page, { q: "canary" });
  await expect(count(page)).toHaveText(messages(all));
  const hits = palette(page).locator("[data-search-result][data-key^='hit:']");
  const more = palette(page).locator("[data-key='more-messages']");
  while (await more.count()) {
    const before = await hits.count();
    await more.click();
    await expect.poll(() => hits.count()).toBeGreaterThan(before);
  }
  await expect(hits).toHaveCount(all);
});

test("Shift Cmd 1 opens the first row", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("pi-cutover");
  await expect(palette(page).locator("[role=group][aria-label='Channels']")).toBeVisible();
  await page.keyboard.press(`Shift+${mod}+Digit1`);
  await expect(page).toHaveURL(/#\/c\/ch_cutover$/);
});
