import { expect, test, type Page } from "@playwright/test";

/**
 * Cmd K search against the chat server's fixture: groups, operators as chips, keyboard moves, exact counts and opening a hit at its
 * message. Cmd F stays the browser's find in page, and a conversation's menu scopes search to it (owner, p124).
 */
const mod = process.platform === "darwin" ? "Meta" : "Control";

const palette = (page: Page) => page.locator("[data-search-palette]");
const field = (page: Page) => palette(page).getByRole("combobox");
const groupNames = (page: Page) => palette(page).locator("[role=group]:not([data-search-places])").evaluateAll(groups => groups.map(g => g.getAttribute("aria-label")));
const count = (page: Page) => palette(page).getByTestId("search-count");
const chips = (page: Page) => palette(page).locator("[data-search-filters]");

async function total(page: Page, params: Record<string, string>): Promise<number> {
  const response = await page.request.get(`/api/search?${new URLSearchParams({ limit: "1", ...params })}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { total: number }).total;
}

const messages = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "message" : "messages"}`;

/** A search's words and filters, without its page size, sort or cursor, as the palette's requests and a test's params both name them. */
const searchKey = (params: URLSearchParams) => JSON.stringify([...params].filter(([name]) => !["limit", "brief", "sort", "cursor"].includes(name)).sort());

/** The total of each first page the palette's own requests got back, by searchKey. */
const answers = new WeakMap<Page, Map<string, number>>();

/**
 * The count shows the exact total the palette's own request got back for these words and filters, which it returns. A GET of its own made
 * after the palette's can count more: every DM another spec sends a fixture agent gets back "I checked the canary and the relay".
 */
async function showsAnswer(page: Page, params: Record<string, string>): Promise<number> {
  const totals = answers.get(page)!;
  const key = searchKey(new URLSearchParams(params));
  await expect
    .poll(async () => {
      const answer = totals.get(key);
      const shown = await count(page).textContent();
      return answer === undefined ? `no answer yet, the count shows ${shown}` : shown === messages(answer) ? "shown" : `the count shows ${shown} for an answer of ${messages(answer)}`;
    })
    .toBe("shown");
  return totals.get(key)!;
}

/** A word only this test wrote, in `posts` posts of a new channel with no members, so no agent answers there and no other spec writes it. */
async function ownWord(page: Page, posts: number): Promise<string> {
  const word = `zq${Array.from({ length: 10 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("")}`;
  const room = (await (await page.request.post("/api/rooms", { data: { kind: "channel", name: `search-${word}`, members: [] } })).json()) as { id: string };
  await Promise.all(Array.from({ length: posts }, (_, n) => page.request.post(`/api/c/${room.id}/send`, { data: { text: `${word} post ${n + 1}`, requestId: crypto.randomUUID() } })));
  await expect.poll(() => total(page, { q: word })).toBe(posts);
  return word;
}

test.beforeEach(async ({ page }) => {
  const totals = new Map<string, number>();
  answers.set(page, totals);
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.pathname !== "/api/search" || url.searchParams.has("cursor") || !response.ok()) return;
    response.json().then(
      (answer: { total: number }) => totals.set(searchKey(url.searchParams), answer.total),
      () => {},
    );
  });
  await page.goto("/#/c/ch_general");
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
});

test("Cmd K opens on this conversation and recent activity, and Esc closes it", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await expect(field(page)).toBeFocused();
  // Recent searches are the owner's on the one fixture server, so other specs' searches may add that group.
  expect((await groupNames(page)).filter(name => name !== "Recent searches")).toEqual(["This conversation", "Recent activity"]);
  await expect(palette(page).locator("[role=group][aria-label='Recent activity'] [data-search-result]")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
});

test("text shows at most 3 named rows before messages, with an exact count and underlined matches", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("relay");
  await showsAnswer(page, { q: "relay" });
  const names = await groupNames(page);
  expect(names[0]).toBe("All results");
  expect(names.at(-1)).toBe("Messages");
  expect(names.indexOf("Conversations")).toBeGreaterThan(0);
  expect(names.indexOf("Conversations")).toBeLessThan(names.indexOf("Messages"));
  expect(await palette(page).locator("[role=group][aria-label='Conversations'] [data-search-result]").count()).toBeLessThanOrEqual(3);
  const marks = await palette(page).locator("[role=group][aria-label='Messages'] mark").allInnerTexts();
  expect(marks.length).toBeGreaterThan(0);
  for (const mark of marks) expect(mark.toLowerCase()).toBe("relay");
});

test("from: picks an author into the From chip, the count follows it, and Backspace removes it", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).pressSequentially("relay from:own");
  await expect(palette(page).locator("[role=group][aria-label='People'] [data-search-result]")).toHaveCount(1);
  await page.keyboard.press("Enter");
  const chip = chips(page).locator("[data-chip=from]");
  await expect(chip).not.toHaveText("From");
  await expect(chip).toContainText("From: ");
  await expect(field(page)).toHaveValue("relay ");
  await showsAnswer(page, { q: "relay", from: "owner" });
  await field(page).press("Home");
  await field(page).press("Backspace");
  await expect(chip).toHaveText("From");
  await showsAnswer(page, { q: "relay" });
});

test("a typed operator lands in its chip once it is complete, and the chip's x removes it", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).pressSequentially("in:pi-cutover relay");
  const chip = chips(page).locator("[data-chip=in]");
  await expect(chip).toHaveText("In: #pi-cutover");
  await expect(field(page)).toHaveValue("relay");
  await showsAnswer(page, { q: "relay", in: "ch_cutover" });
  await chips(page).getByRole("button", { name: "Remove the In filter" }).click();
  await expect(chip).toHaveText("In");
});

test("after: offers date presets, and a bad date stays as text", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).pressSequentially("canary after:");
  const dates = palette(page).locator("[role=group][aria-label='Dates'] [data-search-result]");
  await expect(dates).toHaveCount(5);
  await expect(dates.first()).toContainText("Today");
  const sent = page.waitForRequest(request => /[?&]after=\d{4}-\d{2}-\d{2}/.test(request.url()) && new URL(request.url()).pathname === "/api/search");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const chip = chips(page).locator("[data-chip=date]");
  await expect(chip).toContainText("On or after");
  const date = new URL((await sent).url()).searchParams.get("after")!;
  await showsAnswer(page, { q: "canary", after: date });
  await field(page).fill("canary before:2026-02-30 ");
  await expect(chip).toContainText("On or after");
  await expect(field(page)).toHaveValue("canary before:2026-02-30 ");
});

test("arrow keys move the highlight, Enter opens the hit at its message", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("migration");
  // The rows above the hits are counted once they are all in: the server's messages replace the page's own, and the fixture's
  // migration-signer-recipe wiki page comes in its own request at least 150 ms after the keystroke.
  await showsAnswer(page, { q: "migration" });
  await expect(palette(page).locator("[role=group][aria-label='Pages'] [data-search-result]").first()).toBeVisible();
  const hits = palette(page).locator("[role=group][aria-label='Messages'] [data-search-result]");
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
  // A top-level channel post: its message id is its row's id. A thread hit's row is the turn that holds it, and the fixture's live turn keeps
  // adding hits; a reply lives in its thread, not in the channel's timeline.
  const { hits } = (await (await page.request.get("/api/search?q=relay&limit=20")).json()) as { hits: { id: string; kind: string; where: string }[] };
  const post = hits.find(h => h.kind === "post" && h.id.startsWith("ch_") && h.where === "root")!;
  const hit = palette(page).locator(`[role=group][aria-label='Messages'] [data-key="hit:${post.id}"]`);
  await hit.click();
  const id = new URL(page.url().replace("#/", "")).searchParams.get("m");
  expect(id).toBeTruthy();
  const message = page.locator(`[data-message-id="${id}"]`);
  await expect(message).toBeInViewport();
  await expect(message).toHaveAttribute("data-flash", /.*/);
});

test("Cmd F leaves the page to the browser's find", async ({ page }) => {
  const prevented = await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await page.keyboard.press(`${mod}+f`);
  await expect(palette(page)).toBeHidden();
});

test("the conversation menu scopes search to this conversation, sorts, and the scope chip removes the scope", async ({ page }) => {
  await page.goto("/#/c/ch_cutover");
  await page.getByRole("button", { name: "Channel actions" }).click();
  await page.getByRole("menuitem", { name: "Search in this conversation" }).click();
  await expect(page.getByRole("dialog", { name: "Search this conversation" })).toBeVisible();
  await field(page).fill("relay");
  await showsAnswer(page, { q: "relay", in: "ch_cutover" });
  expect(await groupNames(page)).toEqual(["All results", "Most relevant"]);
  await palette(page).locator("[data-search-sort]").click();
  await page.getByRole("menuitemradio", { name: "Most recent" }).click();
  expect(await groupNames(page)).toEqual(["All results", "Most recent"]);
  await expect(chips(page).locator("[data-chip=in]")).toHaveText("In: #pi-cutover");
  await chips(page).getByRole("button", { name: "Remove the In filter" }).click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await showsAnswer(page, { q: "relay" });
  expect(await groupNames(page)).toContain("This conversation");
  expect((await groupNames(page)).at(-1)).toBe("Messages");
});

/**
 * The menu used to add "Channel details" above "Search in this conversation" once the channel's header came in, so at load a click aimed
 * at Search opened the channel's details (~/work/chat-specs-red/specs-red-search-search/notes.md).
 */
test("the conversation menu's rows above Search stay put when the channel's header comes in", async ({ page }) => {
  const word = `zq${Array.from({ length: 10 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("")}`;
  const room = (await (await page.request.post("/api/rooms", { data: { kind: "channel", name: `menu-${word}`, members: [] } })).json()) as { id: string };
  let release = () => {};
  const held = new Promise<void>(resolve => (release = resolve));
  await page.route(new RegExp(`/api/c/${room.id}(\\?|$)`), async route => {
    await held;
    await route.continue();
  });
  await page.goto(`/#/c/${room.id}`);
  await page.getByRole("button", { name: "Channel actions" }).click();
  const items = page.getByRole("menuitem");
  const above = async () => {
    const labels = await items.allInnerTexts();
    return labels.slice(0, labels.indexOf("Search in this conversation"));
  };
  await expect(page.getByRole("menuitem", { name: "Search in this conversation" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Add people" })).toHaveCount(0);
  const before = await above();
  release();
  await expect(page.getByRole("menuitem", { name: "Add people" })).toBeVisible();
  expect(await above()).toEqual(before);
});

/** A DM's menu had the same shift: "Open agent" and "Jobs" came in above Search with the header. */
test("the conversation menu's rows above Search stay put when a DM's header comes in", async ({ page }) => {
  const agent = (await (await page.request.post("/api/agents", { data: { kind: "chat", name: `menu ${crypto.randomUUID().slice(0, 8)}`, test: true } })).json()) as { id: string; room?: string };
  const room = agent.room ?? `dm_${agent.id.slice(3)}`;
  let release = () => {};
  const held = new Promise<void>(resolve => (release = resolve));
  await page.route(new RegExp(`/api/c/${room}(\\?|$)`), async route => {
    await held;
    await route.continue();
  });
  await page.goto(`/#/c/${room}`);
  await page.getByRole("button", { name: "Conversation actions" }).click();
  const items = page.getByRole("menuitem");
  const above = async () => {
    const labels = await items.allInnerTexts();
    return labels.slice(0, labels.indexOf("Search in this conversation"));
  };
  await expect(page.getByRole("menuitem", { name: "Search in this conversation" })).toBeVisible();
  await expect(page.getByTestId("dm-title-button")).toHaveCount(0);
  const before = await above();
  release();
  await expect(page.getByTestId("dm-title-button")).toBeVisible();
  expect(await above()).toEqual(before);
  expect(before).toEqual(["Open agent", "Jobs"]);
});

test("Show more pages through every hit up to the exact count", async ({ page }) => {
  // Three pages of 20, 20 and 5: a seed word's count grows while the pages load, as the fixture's agents keep writing it.
  const all = 45;
  const word = await ownWord(page, all);
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill(word);
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
  await expect(palette(page).locator("[role=group][aria-label='Conversations'] [data-key='conversation:ch_cutover']")).toBeVisible();
  await page.keyboard.press(`Shift+${mod}+Digit1`);
  await expect(page).toHaveURL(/#\/c\/ch_cutover$/);
});

test("Cmd K rows are one line and 32 px tall, so message hits show above the fold", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 720 });
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("relay");
  const hits = palette(page).locator("[role=group][aria-label='Messages'] [data-search-result]");
  await expect(hits.first()).toBeInViewport();
  const heights = await palette(page).locator("[data-search-result]").evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
  for (const height of heights) expect(height).toBeLessThanOrEqual(34);
});

/**
 * On 11-20 the owner's round trip was 197 ms, and at a simulated 200 ms each keystroke's rows waited 399 to 474 ms for the server
 * (~/work/p101-search-rtt/before-200ms.json). The page matches its own feed of recent messages at the keystroke, and the server's answer
 * replaces those rows.
 */
test("a keystroke shows message rows from the page before the server answers, and the answer then brings the exact count", async ({ page }) => {
  const feed = page.waitForResponse(response => response.url().includes("/api/search/recent") && response.ok());
  await page.reload();
  await feed;
  let release = () => {};
  const held = new Promise<void>(resolve => (release = resolve));
  let asked = 0;
  await page.route(/\/api\/search\?/, async route => {
    asked += 1;
    await held;
    await route.continue();
  });
  await page.keyboard.press(`${mod}+k`);
  await field(page).pressSequentially("relay");
  const rows = palette(page).locator("[role=group][aria-label='Messages'] [data-search-result]");
  await expect(rows.first()).toBeVisible();
  await expect(palette(page).getByTestId("search-pending")).toBeVisible();
  await expect(count(page)).toHaveCount(0);
  const marks = await palette(page).locator("[role=group][aria-label='Messages'] mark").allInnerTexts();
  expect(marks.length).toBeGreaterThan(0);
  for (const mark of marks) expect(mark.toLowerCase()).toBe("relay");
  // Every key sent its request at once, with no wait for the typing to stop.
  expect(asked).toBe(5);
  release();
  await showsAnswer(page, { q: "relay" });
  await expect(palette(page).getByTestId("search-pending")).toHaveCount(0);
});

/**
 * The page records a search's wait from before its fetch until its answer is read (client.ts `send`), so work that runs after the fetch in
 * the keystroke's task holds the answer once that work outlasts the round trip. The request goes before any row renders, and the rows
 * render once per keystroke: before p156 a render of the old rows came first and a second render followed the fetch, and at 4x CPU
 * throttling the task after the fetch took p90 728 ms (~/work/p156-search/p156-client/summary.md).
 */
test("a keystroke's search leaves before its rows render", async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { seenAtSearch: string[] }).seenAtSearch = seen;
    const fetch0 = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/\/api\/search\?/.test(url)) seen.push(document.querySelector("[data-search-palette] [data-key=see-all]")?.textContent ?? "");
      return fetch0.call(this, input, init);
    };
  });
  await page.reload();
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  await field(page).pressSequentially("rel");
  await showsAnswer(page, { q: "rel" });
  await field(page).press("a");
  await showsAnswer(page, { q: "rela" });
  const seen = await page.evaluate(() => (window as unknown as { seenAtSearch: string[] }).seenAtSearch);
  expect(seen.at(-1)).toContain("“rel”");
});

test("the search never waits on the feed: with it blocked, the server's rows and count still show", async ({ page }) => {
  await page.route(/\/api\/search\/recent/, route => route.abort());
  await page.reload();
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("relay");
  await showsAnswer(page, { q: "relay" });
  await expect(palette(page).locator("[role=group][aria-label='Messages'] [data-search-result]").first()).toBeVisible();
});

test("a word typed again shows its earlier answer with no new request", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("relay");
  const relay = await showsAnswer(page, { q: "relay" });
  await field(page).fill("canary");
  const canary = await showsAnswer(page, { q: "canary" });
  expect(canary).not.toBe(relay);
  let asked = 0;
  page.on("request", request => {
    if (/\/api\/search\?/.test(request.url())) asked += 1;
  });
  await field(page).fill("relay");
  await expect(count(page)).toHaveText(messages(relay));
  expect(asked).toBe(0);
});
