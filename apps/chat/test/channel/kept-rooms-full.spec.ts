import { expect, type Page, test } from "@playwright/test";
import { conversation, open } from "./helpers";

/**
 * On 11-23 a reload walk at a 200 ms round trip opened 12 work threads, whose jobs read ahead 101 job pages into the page cache of 140, and
 * all 9 channels it opened next waited 210 to 387 ms: the cache had dropped their pages, and the sidebar's read ahead never reads a room
 * again until it shows newer activity (work/p215-opens). Here 150 pages read ahead fill the cache after the sidebar rooms are kept.
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
  await page.route(/\/api\/c\/ch_fill\d+(\/items)?(\?.*)?$/, (route) => {
    const path = new URL(route.request().url()).pathname;
    const id = /ch_fill\d+/.exec(path)![0];
    return route.fulfill({ json: path.endsWith("/items") ? { items: [] } : { ...header, id } });
  });
  await open(page, "#/c/ch_general");
  await expect.poll(() => keptPage(page, room), { timeout: 30_000 }).toBe(true);

  await page.evaluate(async (n) => {
    const stores = "/src/lib/api/stores.svelte.ts";
    const { listedAhead } = await import(/* @vite-ignore */ stores);
    listedAhead(Array.from({ length: n }, (_, i) => ({ conversation: `ch_fill${i}` })));
  }, FILL);
  await expect.poll(() => keptPage(page, `ch_fill${FILL - 1}`), { timeout: 60_000 }).toBe(true);
  expect(await keptPage(page, room)).toBe(true);

  const asked: string[] = [];
  await page.route(held, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    asked.push(new URL(route.request().url()).pathname);
  });
  await page.evaluate((id) => (location.hash = `#/c/${id}`), room);
  await expect(conversation(page).locator("[data-message-id]").first()).toBeVisible();
});
