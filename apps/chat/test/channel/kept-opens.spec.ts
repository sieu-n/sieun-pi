import { expect, type Page, test } from "@playwright/test";
import { conversation, open, tag } from "./helpers";

/**
 * Opens of rooms the page kept that still waited a round trip on 11-23, about 200 ms from Korea (work/p278-thread-open/census.md): the All
 * unreads page read each unread room as his call, and a Later row's address at a message read the page around it. Each spec holds the
 * reads of the room, so only the page's kept copy can fill the screen.
 */
const keptPage = (page: Page, key: string) =>
  page.evaluate((key) => new Promise<boolean>((resolve) => {
    const opened = indexedDB.open("chat.pages");
    opened.onerror = () => resolve(false);
    opened.onsuccess = () => {
      const db = opened.result;
      if (!db.objectStoreNames.contains("pages")) return resolve(false);
      const got = db.transaction("pages").objectStore("pages").get(["timeline", key]);
      got.onsuccess = () => resolve(got.result !== undefined);
      got.onerror = () => resolve(false);
    };
  }), key);

/** A channel of its own with one post, read ahead and kept by the page; the spec holds every read of the room after that. */
async function keptRoom(page: Page): Promise<{ room: string; post: string; text: string }> {
  const text = `kept post ${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name: `kept-open-${tag()}`, members: [] } })).json()) as { id: string }).id;
  const sent = await page.request.post(`/api/c/${room}/send`, { data: { text, requestId: crypto.randomUUID() } });
  expect(sent.ok()).toBe(true);
  const post = ((await sent.json()) as { item: { id: string } }).item.id;
  await open(page, "#/c/ch_general");
  await expect.poll(() => keptPage(page, room), { timeout: 30_000 }).toBe(true);
  await page.route(new RegExp(`/api/c/${room}(/items)?(\\?.*)?$`), (route) => (route.request().method() === "GET" ? undefined : route.fallback()));
  return { room, post, text };
}

test("All unreads shows a room's new posts from the page's kept copy with no call in front of them", async ({ page }) => {
  const { room, post, text } = await keptRoom(page);
  expect((await page.request.post(`/api/c/${room}/read`, { data: { unreadFrom: post } })).ok()).toBe(true);
  await page.evaluate(() => (location.hash = "#/c/unreads"));
  await expect(page.locator(`[data-unread-room="${room}"]`).getByText(text)).toBeVisible();
});

test("an address at a message the room's kept page holds opens at it with no call in front of its rows", async ({ page }) => {
  const { room, post, text } = await keptRoom(page);
  await page.evaluate(({ room, post }) => (location.hash = `#/c/${room}?m=${post}`), { room, post });
  await expect(conversation(page).getByText(text)).toBeVisible();
});
