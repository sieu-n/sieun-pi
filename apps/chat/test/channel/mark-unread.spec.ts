import { expect, test, type Page, type Request } from "@playwright/test";
import { open, row, tag } from "./helpers.ts";

/**
 * Mark unread in a channel (server/keep-unread.ts), as a picky Slack user checks it: the New line goes over the post, a toast says so, the
 * view stays put, the open room does not read itself again, and the post waits in Later's Keep unread stack until a reply handles it.
 * Each run makes its own channel on the fixture server.
 */
async function channel(page: Page): Promise<{ room: string; posts: { id: string; seq: number }[] }> {
  const name = `unread-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  // The sends go at once and the posts sort by the seq the server gave each. One by one they took 10 s of the 30 s test at load 800 on 11-23.
  const sends = Array.from({ length: 30 }, async (_, n) => {
    const sent = (await (await page.request.post(`/api/c/${room}/send`, { data: { text: `post ${n + 1} of ${name}`, requestId: crypto.randomUUID() } })).json()) as { item: { id: string; seq: number } };
    return sent.item;
  });
  return { room, posts: (await Promise.all(sends)).sort((a, b) => a.seq - b.seq) };
}

test("Alt-click marks a post unread with the New line over it, a toast, no jump and no read of its own", async ({ page }) => {
  const { room, posts } = await channel(page);
  const reads: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/api/c/${room}/read`)) reads.push(r.postData() ?? "");
  });
  await open(page, `#/c/${room}`);
  const target = posts[18]!;
  const post = row(page, target.id);
  await post.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const top = await post.evaluate((el) => el.getBoundingClientRect().top);
  reads.length = 0;

  await post.locator(".body").first().click({ modifiers: ["Alt"] });
  await expect(page.getByRole("status").filter({ hasText: "Marked as unread" })).toBeVisible();
  const line = page.getByTestId("new-line");
  await expect(line).toHaveCount(1);
  expect(await line.evaluate((el) => (el.nextElementSibling as HTMLElement | null)?.dataset.messageId)).toBe(target.id);
  expect(Math.abs((await post.evaluate((el) => el.getBoundingClientRect().top)) - top)).toBeLessThan(2);

  const sidebarRow = page.locator(`[data-sidebar-row][href$="${room}"]`);
  await expect(sidebarRow).toHaveAttribute("data-unread", "true");
  await page.waitForTimeout(2500);
  expect(Math.abs((await post.evaluate((el) => el.getBoundingClientRect().top)) - top), "the post's Kept unread label lands without moving it").toBeLessThan(2);
  await expect(post.locator("[data-saved-label]")).toContainText("Kept unread");
  expect(reads.filter((body) => !body.includes("unreadFrom"))).toEqual([]);
  await expect(sidebarRow).toHaveAttribute("data-unread", "true");

  const later = (await (await page.request.get("/api/later")).json()) as { items: { id: string; unread?: boolean; state: string }[] };
  expect(later.items.find((i) => i.id === `${room}:${target.id}`)).toMatchObject({ unread: true, state: "open" });

  await page.request.post(`/api/c/${room}/send`, { data: { text: "handled", requestId: crypto.randomUUID(), threadRoot: target.id } });
  await expect(sidebarRow).not.toHaveAttribute("data-unread", "true");
  await expect(line).toHaveCount(0);
});

test("a send takes the New line away, and the room reopens with the line in view when it sits above the newest posts", async ({ page }) => {
  const { room, posts } = await channel(page);
  const reading = new Set<Request>();
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/api/c/${room}/read`)) reading.add(r);
  });
  page.on("requestfinished", (r) => reading.delete(r));
  page.on("requestfailed", (r) => reading.delete(r));
  await open(page, `#/c/${room}`);
  const line = page.getByTestId("new-line");
  await row(page, posts[29]!.id).click({ modifiers: ["Alt"], position: { x: 80, y: 12 } });
  await expect(line).toHaveCount(1);
  await page.getByTestId("composer-input").first().fill("done with it");
  await page.keyboard.press("Enter");
  await expect(line).toHaveCount(0);

  // The mark below stands for one from another tab. The page reads the room 400 ms after his send, unless a summary that came by then holds
  // it (Conversation.svelte markRead), and a read that lands after the mark reads over it. At load 150 on 11-23 the read went 1.5 s after
  // the send, and the reopened room had no line. A reload ends that timer, and the mark waits until every read the page sent has its answer.
  await open(page, "#/c/dm_vent");
  await page.reload();
  await expect.poll(() => reading.size).toBe(0);
  await page.request.post(`/api/c/${room}/read`, { data: { unreadFrom: posts[2]!.id } });
  await open(page, `#/c/${room}`);
  await expect(line).toHaveCount(1);
  const feed = page.getByTestId("timeline").first();
  await expect.poll(async () => {
    const [box, at] = await Promise.all([feed.boundingBox(), line.boundingBox()]);
    return !!box && !!at && at.y >= box.y && at.y < box.y + box.height;
  }).toBe(true);
});

test("a menu mark in a DM never scrolls past where it settles", async ({ page }) => {
  // A test agent's DM of quiet sends, which get no answer. In the seeded Vent DM the New line already sits under the last own post at the
  // feed's bottom, where no scroll can hold the post, and check-in answers land at any time and pull the stuck feed down.
  const agent = (await (await page.request.post("/api/agents", { data: { kind: "chat", name: `unread dm ${tag()}`, test: true } })).json()) as { room: string };
  const note = (n: number) => [`quiet note ${n}`, "The relay answered.", "The canary is fine.", "Nothing to send.", "The board has no open step.", "The next check is in two hours."].join("\n\n");
  for (let n = 1; n <= 6; n++) await page.request.post(`/api/c/${agent.room}/send`, { data: { text: note(n), requestId: crypto.randomUUID() } });
  await open(page, `#/c/${agent.room}`);
  const feed = page.getByTestId("timeline").first();
  const own = page.locator("section.conversation [data-own-post]").last();
  await own.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await feed.evaluate((el) => {
    const tops: number[] = [];
    (window as unknown as { tops: number[] }).tops = tops;
    el.addEventListener("scroll", () => tops.push(el.scrollTop));
  });
  const before = await own.evaluate((el) => el.getBoundingClientRect().top);
  await own.hover();
  await own.locator("[data-message-menu]").click();
  await page.getByRole("menuitem", { name: /Mark unread/ }).click();
  await expect(page.getByTestId("new-line")).toHaveCount(1);
  await page.waitForTimeout(2500);
  expect(Math.abs((await own.evaluate((el) => el.getBoundingClientRect().top)) - before)).toBeLessThan(2);
  const tops = await page.evaluate(() => (window as unknown as { tops: number[] }).tops);
  const last = await feed.evaluate((el) => el.scrollTop);
  expect(Math.max(last, ...tops) - last).toBeLessThan(2);
});

test("U marks the hovered post unread, the menu names U, and the hover bar drops after a menu pick", async ({ page }) => {
  const { room, posts } = await channel(page);
  await open(page, `#/c/${room}`);
  const target = row(page, posts[27]!.id);
  await target.hover();
  await target.locator("[data-message-menu]").click();
  const item = page.getByRole("menuitem", { name: /Mark unread/ });
  await expect(item).toContainText("U");
  await item.click();
  await expect(page.getByTestId("new-line")).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect(target.locator("[data-action-bar]")).toHaveCSS("opacity", "0");

  await target.hover();
  await target.locator("[data-message-menu]").click();
  await page.keyboard.press("u");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");

  const other = row(page, posts[25]!.id);
  await other.hover();
  await page.keyboard.press("u");
  await expect.poll(async () => page.getByTestId("new-line").evaluate((el) => (el.nextElementSibling as HTMLElement | null)?.dataset.messageId)).toBe(posts[25]!.id);
});

test("a reply marked unread in the thread pane marks the thread, not the channel", async ({ page }) => {
  const { room, posts } = await channel(page);
  const root = posts[20]!;
  const replies: { id: string }[] = [];
  for (let n = 1; n <= 4; n++) {
    const sent = (await (await page.request.post(`/api/c/${room}/send`, { data: { text: `reply ${n}`, requestId: crypto.randomUUID(), threadRoot: root.id } })).json()) as { item: { id: string } };
    replies.push(sent.item);
  }
  await open(page, `#/c/${room}?thread=${root.id}`);
  const pane = page.getByTestId("thread-pane");
  const main = page.getByTestId("timeline").first();
  const mainTop = await main.evaluate((el) => el.scrollTop);
  const reply = pane.locator(`[data-message-id="${replies[1]!.id}"]`);
  await reply.click({ modifiers: ["Alt"], position: { x: 80, y: 24 } });
  await expect(pane.getByTestId("new-line")).toHaveCount(1);
  expect(await pane.getByTestId("new-line").evaluate((el) => (el.nextElementSibling as HTMLElement | null)?.dataset.messageId)).toBe(replies[1]!.id);
  await expect(conversationLine(page)).toHaveCount(0);
  expect(Math.abs((await main.evaluate((el) => el.scrollTop)) - mainTop)).toBeLessThan(2);
  const summary = ((await (await page.request.get(`/api/c/${room}`)).json()) as { summary: { hasNew: boolean } }).summary;
  expect(summary.hasNew).toBe(false);
  const later = (await (await page.request.get("/api/later")).json()) as { items: { id: string; unread?: boolean }[] };
  expect(later.items.find((i) => i.id === `${room}:${replies[1]!.id}`)?.unread).toBe(true);
});

const conversationLine = (page: Page) => page.locator("section.conversation").getByTestId("timeline").first().getByTestId("new-line");
