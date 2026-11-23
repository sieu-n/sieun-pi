import { expect, type Page, test } from "@playwright/test";
import { conversation, open } from "./helpers";

/**
 * On 11-23 a reload walk at a 200 ms round trip opened 12 work threads, whose jobs read ahead 101 job pages into the page cache of 140, and
 * all 9 channels it opened next waited 210 to 387 ms: the cache had dropped their pages, and the sidebar's read ahead never reads a room
 * again until it shows newer activity (work/p215-opens). Here 150 other pages land in the cache after the sidebar rooms are kept. They land
 * through `keepOpened`, which keeps a page as it is, because a list read ahead is the Cmd K palette's: when the fixture's board tick changed
 * the conversations, its next list dropped the reads still queued, and at box load 340 the fill stopped at 78 of 150 (work/chat-specs-red).
 */
const held = /\/api\/c\/[^/]+(\/items|\/replies\/[^/]+)?(\?.*)?$/;
const FILL = 150;

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

test("a sidebar room stays kept when job pages fill the cache, so it opens with no call in front of its rows", async ({ page, request }) => {
  test.setTimeout(90_000);
  const sidebar = (await (await request.get("/api/sidebar")).json()) as Record<"solo" | "channels" | "dms", { id: string }[]>;
  const room = [...sidebar.channels, ...sidebar.solo].find((r) => r.id !== "ch_general")!.id;
  const header = await (await request.get("/api/c/ch_general")).json();
  await open(page, "#/c/ch_general");
  await expect.poll(() => keptPage(page, room), { timeout: 30_000 }).toBe(true);

  await page.evaluate(async ({ n, header }) => {
    const stores = "/src/lib/api/stores.svelte.ts";
    const { keepOpened } = await import(/* @vite-ignore */ stores);
    for (let i = 0; i < n; i++) keepOpened(`ch_fill${i}`, { page: { items: [] }, header });
  }, { n: FILL, header });
  await expect.poll(() => keptPage(page, `ch_fill${FILL - 1}`)).toBe(true);
  await expect.poll(() => keptPage(page, "ch_fill0")).toBe(false);
  expect(await keptPage(page, room)).toBe(true);

  const asked: string[] = [];
  await page.route(held, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    asked.push(new URL(route.request().url()).pathname);
  });
  await page.evaluate((id) => (location.hash = `#/c/${id}`), room);
  await expect(conversation(page).locator("[data-message-id]").first()).toBeVisible();
});
