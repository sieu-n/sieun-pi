import { expect, test, type Page } from "@playwright/test";

/**
 * Search result cards act like Slack's (owner p142, 11-22: "In general overhaul obviously missing pieces"): hovering a result shows its
 * action bar (react, reply in thread, save for later, copy link, more), a right-click opens every action at the pointer, and Back from an
 * opened result returns to the same card and scroll spot.
 */
type Hit = { id: string; conversation: { id: string; kind: string }; messageId: string; link: string; thread?: { root: string } };

const cards = (page: Page) => page.locator("[data-result-card]");
const cardOf = (page: Page, hit: Hit) => page.locator(`[data-result-card][data-hit-id="${hit.id}"]`);

async function hitsFor(page: Page, q: string): Promise<Hit[]> {
  const response = await page.request.get(`/api/search?${new URLSearchParams({ q, limit: "100" })}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { hits: Hit[] }).hits;
}

const channelPost = (hits: Hit[]) => hits.find(hit => hit.conversation.kind === "channel" && !hit.thread && /^p\d+$/.test(hit.messageId))!;

test("hovering a channel post's result saves it for later, copies its link and opens its thread", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#/search?q=relay");
  const hit = channelPost(await hitsFor(page, "relay"));
  const card = cardOf(page, hit);
  await card.scrollIntoViewIfNeeded();
  await card.hover();
  const bar = card.getByRole("toolbar", { name: "Message actions" });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button")).toHaveCount(5);
  await expect(bar.getByRole("button", { name: "Add reaction" })).toBeVisible();

  await bar.getByRole("button", { name: "Save for later" }).click();
  await expect(bar.getByRole("button", { name: "Remove from Later" })).toHaveAttribute("aria-pressed", "true");
  const saved = await (await page.request.get("/api/later?state=open")).json() as { items: { id: string }[] };
  expect(saved.items.map(item => item.id)).toContain(`${hit.conversation.id}:${hit.messageId}`);
  await bar.getByRole("button", { name: "Remove from Later" }).click();
  await expect(page.getByText("Removed from Later")).toBeVisible();
  await expect(bar.getByRole("button", { name: "Save for later" })).toHaveAttribute("aria-pressed", "false");

  await bar.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText("Link copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/${hit.link}`);

  await bar.getByRole("button", { name: "Reply in thread" }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${hit.conversation.id}\\?thread=${hit.messageId}`));
});

test("a right-click on a result opens every action at the pointer, and a job's result only copies its link", async ({ page }) => {
  await page.goto("/#/search?q=relay");
  const hits = await hitsFor(page, "relay");
  const card = cardOf(page, channelPost(hits));
  await card.scrollIntoViewIfNeeded();
  await card.locator("[data-result-snippet]").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Message actions" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Reply in thread", "Save for later", "Copy link", "Mark unread", /Remind me about this/]);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  const job = cardOf(page, hits.find(hit => !/^(dm|ch|so)_/.test(hit.conversation.id))!);
  await job.scrollIntoViewIfNeeded();
  await job.hover();
  await expect(job.getByRole("toolbar", { name: "Message actions" }).getByRole("button")).toHaveCount(1);
  await expect(job.getByRole("button", { name: "Copy link" })).toBeVisible();
});

test("Back from the 9th result returns to that card and the same scroll spot without a new search", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto("/#/search?q=relay");
  await expect(cards(page).nth(8)).toBeVisible();
  for (let i = 0; i < 8; i += 1) await page.keyboard.press("j");
  const ninth = cards(page).nth(8);
  await expect(ninth).toHaveAttribute("aria-current", "true");
  await expect(ninth.locator("[data-context]").first()).toBeVisible();
  const id = await ninth.getAttribute("data-hit-id");
  const scroller = page.locator("[data-search-results]").locator("xpath=ancestor::div[contains(@class,'scroll')][1]");
  const before = await scroller.evaluate(element => element.scrollTop);
  expect(before).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/c\//);

  let searched = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/search") searched += 1;
  });
  await page.goBack();
  await expect(page).toHaveURL(/#\/search\?q=relay$/);
  const card = page.locator(`[data-result-card][data-hit-id="${id}"]`);
  await expect(card).toHaveAttribute("aria-current", "true");
  await expect(card.locator("[data-result-open]")).toBeFocused();
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeCloseTo(before, -1);
  expect(searched).toBe(0);

  // j moves on from the card he came back to.
  await page.keyboard.press("j");
  await expect(cards(page).nth(9)).toHaveAttribute("aria-current", "true");
});
