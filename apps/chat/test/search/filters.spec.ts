import { expect, test, type Page } from "@playwright/test";

/**
 * The filters under the Cmd K field (owner p115, msg mwomrz5y: "search에서 filter 직관적으로 할수 있어야됨 ... 일단 큰 소스 (by which
 * agent/user), in root message, in thread, diggen in some internal tool call"; p126, msg mwqfy6v3: "Where하고 이 카테고리하고 합쳐서,dropdown
 * 말고 그냥 아이템들 list되어있는 pill들로"): the place pills, From, In and Date work by keyboard and pointer, each change asks the server with
 * the filters, and the count is the server's exact total for them.
 */
const mod = process.platform === "darwin" ? "Meta" : "Control";

const palette = (page: Page) => page.locator("[data-search-palette]");
const field = (page: Page) => palette(page).getByRole("combobox");
const bar = (page: Page) => palette(page).locator("[data-search-filters]");
const count = (page: Page) => palette(page).getByTestId("search-count");
const messages = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "message" : "messages"}`;

/**
 * The next search the page sends whose params pass `check`, with the total the server answered it with. The count must show that total:
 * a second request read later can differ, because every fixture agent turn answers "I checked the canary and the relay" and adds hits.
 */
const asked = (page: Page, check: (params: URLSearchParams) => boolean) =>
  page
    .waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/search" && !url.searchParams.has("cursor") && check(url.searchParams);
    })
    .then(async response => {
      expect(response.ok()).toBe(true);
      return { params: new URL(response.url()).searchParams, total: ((await response.json()) as { total: number }).total };
    });

/** This opening's first answer, for "relay" with no filter. */
let first: number;

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  const sent = asked(page, params => params.get("q") === "relay" && [...params.keys()].every(key => ["q", "sort", "limit", "brief"].includes(key)));
  await field(page).fill("relay");
  first = (await sent).total;
  await expect(count(page)).toHaveText(messages(first));
});

test("Jobs, then Threads, then two people in From, by keyboard: the request carries them all and the count follows", async ({ page }) => {
  // Tab leaves the field for the filter row, which is one stop that starts at the first place pill.
  await page.keyboard.press("Tab");
  const pill = (name: string) => bar(page).locator("[data-search-places]").getByRole("button", { name, exact: true });
  await expect(pill("Channels")).toBeFocused();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowRight");
  await expect(pill("Jobs")).toBeFocused();
  let sent = asked(page, params => params.get("place") === "jobs");
  await page.keyboard.press("Space");
  await expect(pill("Jobs")).toHaveAttribute("aria-pressed", "true");
  await expect(count(page)).toHaveText(messages((await sent).total));
  await page.keyboard.press("ArrowLeft");
  sent = asked(page, params => params.get("place") === "threads,jobs");
  await page.keyboard.press("Enter");
  await expect(pill("Threads")).toHaveAttribute("aria-pressed", "true");
  await expect(count(page)).toHaveText(messages((await sent).total));

  // The arrows go on past the last pill to From.
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowRight");
  const from = bar(page).getByRole("button", { name: "From", exact: true });
  await expect(from).toBeFocused();
  await expect(from).toHaveAttribute("aria-haspopup", "dialog");
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "From" });
  await expect(picker).toBeVisible();
  await page.keyboard.type("vent");
  sent = asked(page, params => params.get("from") === "ag_vent" && params.get("place") === "threads,jobs");
  await page.keyboard.press("Enter");
  await sent;
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type("me");
  sent = asked(page, params => params.get("from") === "ag_vent,owner" && params.get("place") === "threads,jobs");
  await page.keyboard.press("Enter");
  const both = await sent;
  // A pick clears the search for the next name, as Slack's add dialog does, so the whole list shows again with both picks checked.
  await expect(picker.getByRole("searchbox", { name: "Find a person or agent" })).toHaveValue("");
  await expect(picker.getByRole("option", { selected: true })).toHaveText([/You/, /Vent/]);
  // Esc closes the dropdown and leaves the search open, with focus back on the chip.
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(palette(page)).toBeVisible();
  const fromChip = bar(page).locator("[data-chip=from]");
  await expect(fromChip).toHaveText("From: Vent, You");
  await expect(count(page)).toHaveText(messages(both.total));
  // Every row sits in a thread or inside a job.
  const places = palette(page).locator("[role=group][aria-label='Messages'] [data-search-result] [data-hit-place]");
  await expect(places.first()).toBeVisible();
  for (const where of await places.evaluateAll(list => list.map(place => place.getAttribute("data-where")))) expect(["thread", "tool"]).toContain(where);
});

test("a chip's x removes its filter, and a date preset narrows the count", async ({ page }) => {
  await bar(page).getByRole("button", { name: "From", exact: true }).click();
  let sent = asked(page, params => params.get("from") === "owner");
  await page.getByRole("dialog", { name: "From" }).getByRole("option", { name: /You/ }).click();
  const mine = await sent;
  await page.keyboard.press("Escape");
  await expect(count(page)).toHaveText(messages(mine.total));

  // Taking the filter off shows this opening's first answer again, which the page kept, so no request goes out.
  await bar(page).getByRole("button", { name: "Remove the From filter" }).click();
  await expect(bar(page).locator("[data-chip=from]")).toHaveText("From");
  await expect(count(page)).toHaveText(messages(first));

  await bar(page).getByRole("button", { name: "Date" }).click();
  sent = asked(page, params => /^\d{4}-\d{2}-\d{2}$/.test(params.get("after") ?? ""));
  await page.getByRole("menuitemradio", { name: "Last 7 days" }).click();
  const week = await sent;
  await expect(bar(page).locator("[data-chip=date]")).toHaveText("Last 7 days");
  await expect(count(page)).toHaveText(messages(week.total));
});

test("a typed operator lands in the same chip as a pick, and Backspace at the start takes the last chip back", async ({ page }) => {
  await field(page).fill("");
  const sent = asked(page, params => params.get("q") === "relay" && params.get("from") === "ag_vent");
  await field(page).pressSequentially("relay from:vent ");
  await expect(bar(page).locator("[data-chip=from]")).toHaveText("From: Vent");
  await expect(field(page)).toHaveValue("relay ");
  await expect(count(page)).toHaveText(messages((await sent).total));
  await bar(page).getByRole("button", { name: "From: Vent" }).click();
  await expect(page.getByRole("dialog", { name: "From" }).getByRole("option", { name: /Vent/, selected: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await field(page).press("Home");
  await field(page).press("Backspace");
  await expect(bar(page).locator("[data-chip=from]")).toHaveText("From");
});
