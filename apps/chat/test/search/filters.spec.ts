import { expect, test, type Page } from "@playwright/test";

/**
 * The filter chips under the Cmd K field (owner p115, msg mwomrz5y: "search에서 filter 직관적으로 할수 있어야됨 ... 일단 큰 소스 (by which
 * agent/user), in root message, in thread, diggen in some internal tool call"): From, In, Where and Date work by keyboard and pointer,
 * each change asks the server with the filters, and the count is the server's exact total for them.
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

/** The next search the page sends whose params pass `check`. */
const asked = (page: Page, check: (params: URLSearchParams) => boolean) =>
  page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === "/api/search" && !url.searchParams.has("cursor") && check(url.searchParams);
  });

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("relay");
  await expect(count(page)).toHaveText(messages(await total(page, { q: "relay" })));
});

test("two people in From, then Inside work, by keyboard: the request carries both and the count follows", async ({ page }) => {
  // Tab leaves the field for the chip row, which is one stop that starts at From.
  await page.keyboard.press("Tab");
  const from = bar(page).getByRole("button", { name: "From", exact: true });
  await expect(from).toBeFocused();
  await expect(from).toHaveAttribute("aria-haspopup", "dialog");
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "From" });
  await expect(picker).toBeVisible();
  await page.keyboard.type("vent");
  let sent = asked(page, params => params.get("from") === "ag_vent");
  await page.keyboard.press("Enter");
  await sent;
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type("me");
  sent = asked(page, params => params.get("from") === "ag_vent,owner");
  await page.keyboard.press("Enter");
  await sent;
  await expect(picker.getByRole("option", { selected: true })).toHaveCount(1);
  // Esc closes the dropdown and leaves the search open, with focus back on the chip.
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(palette(page)).toBeVisible();
  const fromChip = bar(page).locator("[data-chip=from]");
  await expect(fromChip).toHaveText("From: Vent, You");
  await expect(count(page)).toHaveText(messages(await total(page, { q: "relay", from: "ag_vent,owner" })));

  // The arrows move along the row: the From chip's x, In, then Where.
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowRight");
  await expect(bar(page).getByRole("button", { name: "Where" })).toBeFocused();
  await page.keyboard.press("Space");
  const inside = page.getByRole("menuitemcheckbox", { name: /Inside work/ });
  await expect(page.getByRole("menuitemcheckbox").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(inside).toBeFocused();
  sent = asked(page, params => params.get("where") === "tool" && params.get("from") === "ag_vent,owner");
  await page.keyboard.press("Space");
  await sent;
  await expect(inside).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeVisible();
  await expect(bar(page).locator("[data-chip=where]")).toHaveText("Inside work");
  const filtered = await total(page, { q: "relay", from: "ag_vent,owner", where: "tool" });
  await expect(count(page)).toHaveText(messages(filtered));
  // Every row says it sits inside work.
  const places = palette(page).locator("[role=group][aria-label='Messages'] [data-search-result] [data-hit-place]");
  await expect(places.first()).toBeVisible();
  for (const where of await places.evaluateAll(list => list.map(place => place.getAttribute("data-where")))) expect(where).toBe("tool");
});

test("a chip's x removes its filter, and a date preset narrows the count", async ({ page }) => {
  await bar(page).getByRole("button", { name: "From", exact: true }).click();
  let sent = asked(page, params => params.get("from") === "owner");
  await page.getByRole("dialog", { name: "From" }).getByRole("option", { name: /You/ }).click();
  await sent;
  await page.keyboard.press("Escape");
  await expect(count(page)).toHaveText(messages(await total(page, { q: "relay", from: "owner" })));

  // Taking the filter off shows this opening's first answer again, which the page kept, so no request goes out.
  await bar(page).getByRole("button", { name: "Remove the From filter" }).click();
  await expect(bar(page).locator("[data-chip=from]")).toHaveText("From");
  await expect(count(page)).toHaveText(messages(await total(page, { q: "relay" })));

  await bar(page).getByRole("button", { name: "Date" }).click();
  sent = asked(page, params => /^\d{4}-\d{2}-\d{2}$/.test(params.get("after") ?? ""));
  await page.getByRole("menuitemradio", { name: "Last 7 days" }).click();
  const after = (await sent).url().match(/after=(\d{4}-\d{2}-\d{2})/)![1]!;
  await expect(bar(page).locator("[data-chip=date]")).toHaveText("Last 7 days");
  await expect(count(page)).toHaveText(messages(await total(page, { q: "relay", after })));
});

test("a typed operator lands in the same chip as a pick, and Backspace at the start takes the last chip back", async ({ page }) => {
  await field(page).fill("");
  await field(page).pressSequentially("relay from:vent ");
  await expect(bar(page).locator("[data-chip=from]")).toHaveText("From: Vent");
  await expect(field(page)).toHaveValue("relay ");
  await expect(count(page)).toHaveText(messages(await total(page, { q: "relay", from: "ag_vent" })));
  await bar(page).getByRole("button", { name: "From: Vent" }).click();
  await expect(page.getByRole("dialog", { name: "From" }).getByRole("option", { name: /Vent/, selected: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await field(page).press("Home");
  await field(page).press("Backspace");
  await expect(bar(page).locator("[data-chip=from]")).toHaveText("From");
});
