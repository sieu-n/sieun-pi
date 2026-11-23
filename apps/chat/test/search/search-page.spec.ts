import { expect, test, type Page } from "@playwright/test";

/**
 * Search like Slack (owner, 2026-10-28: "뭐가 뭔지 좀 구분 좀 해주고, 엔터 하면 full screen, with context"): Cmd K rows say who said what
 * where, Enter on the query opens the full results page with the exact count and one card per hit, filter chips narrow it through the
 * address, and a card opens its message in its conversation.
 */
const mod = process.platform === "darwin" ? "Meta" : "Control";

type Hit = { id: string; conversation: { id: string; name: string; kind: string; parent?: { id: string; name: string } }; messageId: string; author: { name: string; kind: string }; role: string; kind: string; tool?: string };
type Result = { hits: Hit[]; total: number };

const palette = (page: Page) => page.locator("[data-search-palette]");
const field = (page: Page) => palette(page).getByRole("combobox");
const cards = (page: Page) => page.locator("[data-result-card]");
const count = (page: Page) => page.getByTestId("results-count");
const filters = (page: Page) => page.locator("[data-search-filters]");
const results = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "result" : "results"}`;

async function search(page: Page, params: Record<string, string>): Promise<Result> {
  const response = await page.request.get(`/api/search?${new URLSearchParams({ limit: "100", ...params })}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as Result;
}

/**
 * A word only this test wrote: `posts` top-level posts in a new channel, and an ask in a new agent's work thread that the agent hands to a
 * job, whose tool output says the word back. The fixture's agents write "relay" into their threads all through a run, so a search for a
 * seed word changes its count and its pages while a test reads them.
 */
async function ownWord(page: Page, posts: number): Promise<string> {
  const word = `zq${Array.from({ length: 10 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("")}`;
  // A quiet turn sends nothing to the owner, so the job's ask, its call and its tool output are the agent's only words with the word.
  const agent = (await (await page.request.post("/api/agents", { data: { kind: "chat", name: `search ${word}` } })).json()) as { thread: string };
  await page.request.post(`/api/c/${agent.thread}/send`, { data: { text: `quiet spawn ${word}`, requestId: crypto.randomUUID() } });
  const room = (await (await page.request.post("/api/rooms", { data: { kind: "channel", name: `search-${word}`, members: [] } })).json()) as { id: string };
  await Promise.all(Array.from({ length: posts }, (_, n) => page.request.post(`/api/c/${room.id}/send`, { data: { text: `${word} post ${n + 1}`, requestId: crypto.randomUUID() } })));
  await expect.poll(async () => (await search(page, { q: word })).hits.some(hit => hit.kind === "tool")).toBe(true);
  return word;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
});

test("Cmd K message rows show the author, an AGENT badge, the place and what kind of text matched", async ({ page }) => {
  const { hits } = await search(page, { q: "ECONNREFUSED" });
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("ECONNREFUSED");
  const rows = palette(page).locator("[role=group][aria-label='Messages'] [data-search-result]");
  await expect(rows).toHaveCount(hits.length);
  for (const hit of hits) {
    const row = palette(page).locator(`[data-key="hit:${hit.id}"]`);
    await expect(row.locator("[data-hit-author]")).toHaveText(hit.author.kind === "owner" ? "You" : hit.author.name);
    // A job that wrote the hit is named as its author, so its place names the agent it works for.
    const named = hit.conversation.parent && hit.author.name === hit.conversation.name;
    await expect(row.locator("[data-hit-place]")).toContainText(named ? hit.conversation.parent!.name : hit.conversation.name);
    if (hit.author.kind === "agent") await expect(row.getByText("AGENT", { exact: true })).toBeVisible();
    if (hit.role === "tool") await expect(row.locator("[data-hit-what]")).toHaveText(`tool output · ${hit.tool}`);
  }
  // A job reads under its parent agent.
  const job = hits.find(hit => hit.conversation.id.includes(":"))!;
  await expect(palette(page).locator(`[data-key="hit:${job.id}"] [data-hit-place]`)).toHaveAttribute("title", new RegExp(`Vent › ${job.conversation.name}`));
});

test("Enter on the query opens the full results page with the exact count and one card per hit", async ({ page }) => {
  // Three pages of hits, so the page has to read on twice as he scrolls.
  const word = await ownWord(page, 45);
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill(word);
  await expect(palette(page).getByTestId("search-count")).toBeVisible();
  await expect(palette(page).locator("[aria-selected=true]")).toContainText(`See all results for “${word}”`);
  const answer = page.waitForResponse(r => {
    const url = new URL(r.url());
    return url.pathname === "/api/search" && url.searchParams.get("q") === word && !url.searchParams.has("local") && !url.searchParams.has("cursor");
  });
  await page.keyboard.press("Enter");
  const { total, hits } = (await (await answer).json()) as Result;
  expect(total).toBeGreaterThan(40);
  await expect(palette(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`#/search\\?q=${word}$`));
  await expect(page.getByRole("heading", { name: `Results for: ${word}` })).toBeVisible();
  await expect(count(page)).toHaveText(results(total));
  await expect(cards(page).first()).toBeVisible();
  // Each scroll to the bottom reads the next page, until the page says it shows every hit.
  for (let shown = 0; !(await page.getByText("That's every result.").isVisible()); shown = await cards(page).count()) {
    await page.locator("[data-search-results]").evaluate(element => element.closest(".scroll")?.scrollTo(0, 1e6));
    await expect(cards(page)).not.toHaveCount(shown);
  }
  await expect(cards(page)).toHaveCount(total);
  await expect(count(page)).toHaveText(results(total));
  const first = cards(page).first();
  await expect(first.locator("[data-hit-author]")).toHaveText(hits[0]!.author.kind === "owner" ? "You" : hits[0]!.author.name);
  await expect(first.locator("[data-result-snippet] mark").first()).toHaveText(word);
  // Tool output comes after every message by relevance.
  const kinds = await cards(page).evaluateAll(list => list.map(card => card.getAttribute("data-kind")));
  expect(kinds.indexOf("tool")).toBeGreaterThan(0);
  expect(kinds.slice(kinds.indexOf("tool")).every(kind => kind === "tool")).toBe(true);
});

test("the same filter chips as Cmd K narrow the results through the address, and back undoes them", async ({ page }) => {
  const word = await ownWord(page, 3);
  await page.goto(`/#/search?q=${word}`);
  const all = await search(page, { q: word });
  await expect(count(page)).toHaveText(results(all.total));
  await filters(page).getByRole("button", { name: "From", exact: true }).click();
  await page.getByRole("dialog", { name: "From" }).getByRole("option", { name: /You/ }).click();
  await expect(page).toHaveURL(/from=owner/);
  await page.keyboard.press("Escape");
  const mine = await search(page, { q: word, from: "owner" });
  await expect(count(page)).toHaveText(results(mine.total));
  expect(mine.total).toBeLessThan(all.total);
  await expect(cards(page)).toHaveCount(mine.total);
  for (const name of await cards(page).locator("[data-hit-author]").allInnerTexts()) expect(name).toBe("You");

  await filters(page).getByRole("button", { name: "Remove the From filter" }).click();
  await expect(page).not.toHaveURL(/from=/);
  const jobsPill = filters(page).locator("[data-search-places]").getByRole("button", { name: "Jobs" });
  await expect(jobsPill).toHaveAttribute("aria-pressed", "false");
  await jobsPill.click();
  await expect(page).toHaveURL(/place=jobs/);
  await expect(jobsPill).toHaveAttribute("aria-pressed", "true");
  const jobs = await search(page, { q: word, place: "jobs" });
  expect(jobs.total).toBeGreaterThan(0);
  await expect(count(page)).toHaveText(results(jobs.total));
  await expect(cards(page).first()).toBeVisible();
  for (const where of await cards(page).locator("[data-hit-place]").evaluateAll(list => list.map(place => place.getAttribute("data-where")))) expect(where).toBe("tool");

  await page.goBack();
  await expect(page).not.toHaveURL(/place=/);
  await expect(count(page)).toHaveText(results(all.total));
  await page.goBack();
  await expect(page).toHaveURL(/from=owner/);
  await expect(count(page)).toHaveText(results(mine.total));
});

test("a card shows the messages around it and opens its message in the conversation", async ({ page }) => {
  await page.goto("/#/search?q=canary%20relay%20drop");
  const { hits } = await search(page, { q: "canary relay drop" });
  // The owner's ask sits in Vent's work thread, which is a registered agent's, so it is no solo chat.
  const ask = hits.find(hit => hit.author.kind === "owner" && hit.conversation.name === "Vent")!;
  const card = page.locator(`[data-result-card][data-hit-id="${ask.id}"]`);
  await card.locator("[data-result-more]").click();
  await expect(card.locator("[data-context=after]")).toContainText("Vent");
  await expect(card.locator("[data-context=after]")).toContainText("lost the Mac");

  await page.goto("/#/search?q=relay&in=ch_cutover");
  // A reply lives in its thread, not in the channel's timeline, so the card opened is a top-level post.
  const post = (await search(page, { q: "relay", in: "ch_cutover" })).hits.find(hit => (hit as { where?: string }).where === "root")!;
  // The flash lasts 2 s (Timeline.svelte), which a check after the scroll can miss on a loaded box, so the page notes each row it flashes.
  await page.evaluate(() => {
    const flashed: string[] = ((window as unknown as { flashed: string[] }).flashed = []);
    new MutationObserver(() => {
      for (const row of document.querySelectorAll<HTMLElement>("[data-flash]")) flashed.push(row.dataset.messageId ?? "");
    }).observe(document.body, { subtree: true, childList: true, attributeFilter: ["data-flash"] });
  });
  await page.locator(`[data-result-card][data-hit-id="${post.id}"] [data-result-open]`).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${post.conversation.id}\\?m=${post.messageId}$`));
  const message = page.locator(`[data-message-id="${post.messageId}"]`);
  await expect(message).toBeInViewport();
  await expect.poll(() => page.evaluate(() => (window as unknown as { flashed: string[] }).flashed)).toContain(post.messageId);
});

test("arrow keys move between cards, the focused card shows its context, and Enter opens it", async ({ page }) => {
  await page.goto("/#/search?q=canary%20relay%20drop");
  const { hits } = await search(page, { q: "canary relay drop" });
  await expect(cards(page)).toHaveCount(hits.length);
  await page.locator("body").press("ArrowDown");
  const second = cards(page).nth(1);
  await expect(second).toHaveAttribute("aria-current", "true");
  await expect(second.locator("[data-context]").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/c/${hits[1]!.conversation.id}\\?m=${hits[1]!.messageId}$`));
});
