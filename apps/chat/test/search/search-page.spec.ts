import { expect, test, type Page } from "@playwright/test";

/**
 * Search like Slack (owner, 2026-10-28: "뭐가 뭔지 좀 구분 좀 해주고, 엔터 하면 full screen, with context"): Cmd K rows say who said what
 * where, Enter on the query opens the full results page with the exact count and one card per hit, filter chips narrow it through the
 * address, and a card opens its message in its conversation.
 */
const mod = process.platform === "darwin" ? "Meta" : "Control";

type Hit = { id: string; conversation: { id: string; name: string; kind: string }; messageId: string; author: { name: string; kind: string }; role: string; kind: string; tool?: string };
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
    await expect(row.locator("[data-hit-place]")).toContainText(hit.conversation.name);
    if (hit.author.kind === "agent") await expect(row.getByText("AGENT", { exact: true })).toBeVisible();
    if (hit.role === "tool") await expect(row.locator("[data-hit-what]")).toHaveText(`in tool output · ${hit.tool}`);
  }
  // A job reads under its parent agent.
  const job = hits.find(hit => hit.conversation.id.includes(":"))!;
  await expect(palette(page).locator(`[data-key="hit:${job.id}"] [data-hit-place]`)).toContainText("Vent›");
});

test("Enter on the query opens the full results page with the exact count and one card per hit", async ({ page }) => {
  const { total, hits } = await search(page, { q: "relay" });
  await page.keyboard.press(`${mod}+k`);
  await field(page).fill("relay");
  await expect(palette(page).getByTestId("search-count")).toBeVisible();
  await expect(palette(page).locator("[aria-selected=true]")).toContainText("See all results for “relay”");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(page).toHaveURL(/#\/search\?q=relay$/);
  await expect(page.getByRole("heading", { name: "Results for: relay" })).toBeVisible();
  await expect(count(page)).toHaveText(results(total));
  await expect(cards(page).first()).toBeVisible();
  // The page scrolls in every hit up to the exact count.
  await page.locator("[data-search-results]").evaluate(element => element.closest(".scroll")?.scrollTo(0, 1e6));
  await expect(cards(page)).toHaveCount(total);
  const first = cards(page).first();
  await expect(first.locator("[data-hit-author]")).toHaveText(hits[0]!.author.kind === "owner" ? "You" : hits[0]!.author.name);
  await expect(first.locator("[data-result-snippet] mark").first()).toHaveText(/relay/i);
  // Tool output comes after every message by relevance.
  const kinds = await cards(page).evaluateAll(list => list.map(card => card.getAttribute("data-kind")));
  expect(kinds.indexOf("tool")).toBeGreaterThan(0);
  expect(kinds.slice(kinds.indexOf("tool")).every(kind => kind === "tool")).toBe(true);
});

test("filter chips narrow the results through the address, and back undoes them", async ({ page }) => {
  await page.goto("/#/search?q=relay");
  const all = await search(page, { q: "relay" });
  await expect(count(page)).toHaveText(results(all.total));
  await filters(page).getByRole("button", { name: "You only" }).click();
  await expect(page).toHaveURL(/from=owner/);
  const mine = await search(page, { q: "relay", from: "owner" });
  await expect(count(page)).toHaveText(results(mine.total));
  expect(mine.total).toBeLessThan(all.total);
  await expect(cards(page)).toHaveCount(mine.total);
  for (const name of await cards(page).locator("[data-hit-author]").allInnerTexts()) expect(name).toBe("You");

  await filters(page).getByRole("button", { name: "You only" }).click();
  await expect(page).not.toHaveURL(/from=/);
  await filters(page).getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /Tool output only/ }).click();
  await expect(page).toHaveURL(/type=tools/);
  const tools = await search(page, { q: "relay", type: "tools" });
  expect(tools.total).toBeGreaterThan(0);
  await expect(count(page)).toHaveText(results(tools.total));
  await expect(filters(page).getByRole("button", { name: "Tool output only" })).toBeVisible();
  await expect(cards(page)).toHaveCount(tools.total);
  await expect(page.locator("[data-result-card]:not([data-role=tool])")).toHaveCount(0);

  await page.goBack();
  await expect(page).not.toHaveURL(/type=/);
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
  const post = (await search(page, { q: "relay", in: "ch_cutover" })).hits[0]!;
  await page.locator(`[data-result-card][data-hit-id="${post.id}"] [data-result-open]`).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${post.conversation.id}\\?m=${post.messageId}$`));
  const message = page.locator(`[data-message-id="${post.messageId}"]`);
  await expect(message).toBeInViewport();
  await expect(message).toHaveAttribute("data-flash", /.*/);
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
