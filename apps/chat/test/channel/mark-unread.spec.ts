import { expect, test, type Page } from "@playwright/test";
import { open, row, tag } from "./helpers.ts";

/**
 * Mark unread in a channel (server/keep-unread.ts), as a picky Slack user checks it: the New line goes over the post, a toast says so, the
 * view stays put, the open room does not read itself again, and the post waits in Later's Keep unread stack until a reply handles it.
 * Each run makes its own channel on the fixture server.
 */
async function channel(page: Page): Promise<{ room: string; posts: { id: string; seq: number }[] }> {
  const name = `unread-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  const posts: { id: string; seq: number }[] = [];
  for (let n = 1; n <= 30; n++) {
    const sent = (await (await page.request.post(`/api/c/${room}/send`, { data: { text: `post ${n} of ${name}`, requestId: crypto.randomUUID() } })).json()) as { item: { id: string; seq: number } };
    posts.push(sent.item);
  }
  return { room, posts };
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
  await expect(target.locator(".actions")).toHaveCSS("opacity", "0");

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
