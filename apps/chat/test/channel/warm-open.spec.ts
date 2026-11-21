import { expect, type Page, test } from "@playwright/test";
import { conversation, open, row, VENT, VENT_JOB } from "./helpers";

/**
 * The owner reads :5184 from Korea at a 197 ms round trip (11-19). On that day a room's first page took him 403 to 455 ms and a thread's
 * replies 648 ms, with nothing on the screen until they came. The page now reads the sidebar's rooms and a channel's threads ahead, so an
 * open shows them from the page's cache. These specs hold every later read of a conversation, so only that cache can fill the screen.
 */
const held = /\/api\/c\/[^/]+(\/items|\/replies\/[^/]+)?(\?.*)?$/;

/** Whether the page cache keeps a page for `key` in IndexedDB (page-db.ts), which it does only once the whole read ahead is in. */
const keptPage = (page: Page, cache: string, key: string) =>
  page.evaluate(([cache, key]) => new Promise<boolean>((resolve) => {
    const opened = indexedDB.open("chat.pages");
    opened.onerror = () => resolve(false);
    opened.onsuccess = () => {
      const db = opened.result;
      if (!db.objectStoreNames.contains("pages")) return resolve(false);
      const got = db.transaction("pages").objectStore("pages").get([cache, key]);
      got.onsuccess = () => resolve(got.result !== undefined);
      got.onerror = () => resolve(false);
    };
  }), [cache, key] as const);

test("a channel thread and a room the owner has not opened yet show their messages with no call in front of them", async ({ page, request }) => {
  const sidebar = (await (await request.get("/api/sidebar")).json()) as { dms: { id: string }[] };
  const dm = sidebar.dms[0]!.id;
  const warmed = Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/c/ch_cutover/replies/p1")),
    page.waitForResponse((r) => r.url().includes(`/api/c/${dm}/items`)),
    page.waitForResponse((r) => r.url().endsWith(`/api/c/${dm}`)),
  ]);
  await open(page, "#/c/ch_cutover");
  await warmed;
  // The answer is in; one more turn of the page's loop keeps it as the page to show.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));

  const asked: string[] = [];
  await page.route(held, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    asked.push(new URL(route.request().url()).pathname);
  });

  await row(page, "p1").locator("[data-thread-pill]").click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane.locator("[data-message-id]").first()).toHaveAttribute("data-message-id", "p1");
  await expect(pane).toContainText("The crawler still uses the old relay port.");

  await page.locator(`a[href="#/c/${dm}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`#/c/${dm}`));
  await expect(conversation(page).locator("[data-message-id]").first()).toBeVisible();
  // Both opens asked for a refresh, and the screen filled while those calls hung.
  expect(asked).toContain("/api/c/ch_cutover/replies/p1");
  expect(asked).toContain(`/api/c/${dm}/items`);
});

test("a read ahead and an unchanged refresh are logged as background, and a first open as a wait", async ({ page, request }) => {
  const sidebar = (await (await request.get("/api/sidebar")).json()) as { dms: { id: string }[] };
  const dm = sidebar.dms[0]!.id;
  // A beacon's body cannot be read here, so the last batch goes out as the fetch the page falls back to.
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false;
  });
  const warmed = page.waitForResponse((r) => r.url().includes(`/api/c/${dm}/items`));
  await open(page, "#/c/ch_cutover");
  await warmed;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  const refreshed = page.waitForResponse((r) => r.url().includes(`/api/c/${dm}/items`));
  await page.locator(`a[href="#/c/${dm}"]`).first().click();
  await expect(conversation(page).locator("[data-message-id]").first()).toBeVisible();
  await refreshed;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));

  // The page posts its last batch of waits as it goes away.
  const batch = page.waitForRequest((r) => r.url().endsWith("/api/timings"));
  await page.evaluate(() => dispatchEvent(new Event("pagehide")));
  const samples = ((await batch).postDataJSON() as { samples: { p: string; bg?: string }[] }).samples;
  const of = (path: string) => samples.filter((s) => s.p === path).map((s) => s.bg ?? "waited");
  expect(of("/api/c/ch_cutover/items")).toEqual(["waited"]);
  expect(of(`/api/c/${dm}/items`)).toEqual(["ahead", "shown"]);
  expect(of("/api/c/ch_cutover/replies/p1")).toEqual(["ahead"]);
});

test("a job pill opens from a short page read ahead, and its refresh asks for the same short page", async ({ page }) => {
  const job = `/api/c/${encodeURIComponent(VENT_JOB)}`;
  const ahead = page.waitForResponse((r) => new URL(r.url()).pathname === `${job}/items`);
  await open(page, `#/c/${VENT}`);
  expect(new URL((await ahead).url()).searchParams.get("limit")).toBe("10");
  // The read ahead also reads the job's header, and an open while that call is on its way takes the read over instead of refreshing.
  await expect.poll(() => keptPage(page, "timeline", VENT_JOB)).toBe(true);

  const asked: string[] = [];
  await page.route((url) => url.pathname.startsWith(job), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    asked.push(new URL(route.request().url()).search);
  });
  await row(page, "t12").locator("[data-thread-pill]").click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane.locator("[data-message-id]").first()).toBeVisible();
  expect(asked).toContain("?limit=10");
});
