import { expect, test } from "@playwright/test";
import { conversation, open } from "./helpers";

/**
 * A new release reloads the page when the owner switches away (reload.ts). On 11-20, 197 ms from the box, four such loads from 06:43 to
 * 06:58 KST each waited 204 to 222 ms for the room's items and for the replies of the thread that was open, with nothing on the screen.
 * The page now keeps its pages in IndexedDB (page-db.ts), so a load shows them at once, and it reads ahead the rooms Cmd K lists.
 */
const held = /\/api\/c\/[^/]+(\/items|\/replies\/[^/]+)?(\?.*)?$/;

test("a reload shows the room and its open thread from the pages the last load kept, and logs their reads as refreshes", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false;
  });
  const read = Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/c/ch_general/items")),
    page.waitForResponse((r) => r.url().includes("/api/c/ch_general/replies/")),
  ]);
  await open(page, "#/c/ch_general");
  const pill = conversation(page).locator("[data-thread-pill]").first();
  await pill.click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane.locator("[data-message-id]").nth(1)).toBeVisible();
  await read;
  // The answers are in; one more turn of the page's loop keeps them.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));

  // Every read of a conversation hangs for a moment after the reload, so only the kept pages can fill the screen.
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const asked: string[] = [];
  await page.route(held, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    asked.push(new URL(route.request().url()).pathname);
    await gate;
    await route.fallback();
  });
  await page.reload();
  await expect(conversation(page).locator("[data-message-id]").first()).toBeVisible();
  await expect(pane.locator("[data-message-id]").nth(1)).toBeVisible();
  expect(asked).toContain("/api/c/ch_general/items");
  expect(asked.some((path) => path.startsWith("/api/c/ch_general/replies/"))).toBe(true);

  const refreshed = Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/c/ch_general/items")),
    page.waitForResponse((r) => r.url().includes("/api/c/ch_general/replies/")),
  ]);
  release();
  await refreshed;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  const batch = page.waitForRequest((r) => r.url().endsWith("/api/timings"));
  await page.evaluate(() => dispatchEvent(new Event("pagehide")));
  const samples = ((await batch).postDataJSON() as { samples: { p: string; bg?: string }[] }).samples;
  const of = (match: (path: string) => boolean) => samples.filter((s) => match(s.p)).map((s) => s.bg ?? "waited");
  expect(of((path) => path === "/api/c/ch_general/items")).toEqual(["shown"]);
  expect(of((path) => path.startsWith("/api/c/ch_general/replies/"))).toContain("shown");
  expect(of((path) => path.startsWith("/api/c/ch_general/replies/"))).not.toContain("waited");
});

test("a room Cmd K lists is read before the owner picks it", async ({ page, request }) => {
  const sidebar = (await (await request.get("/api/sidebar")).json()) as Record<"solo" | "channels", { id: string; name: string; lastActivityAt: number }[]>;
  // The room the sidebar's read ahead reaches last, one at a time; with every such read held, it never gets there.
  const last = [...sidebar.solo, ...sidebar.channels].filter((room) => room.id !== "ch_general").sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0]!;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const asked: string[] = [];
  await page.route(/\/api\/c\/[^/]+\/items(\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET" || path === "/api/c/ch_general/items") return route.fallback();
    asked.push(path);
    await gate;
    await route.fallback();
  });
  await open(page, "#/c/ch_general");
  await page.keyboard.press("Control+k");
  const palette = page.locator("[data-search-palette]");
  await palette.getByRole("combobox").fill(last.name);
  const hit = palette.locator("[data-search-result]").filter({ hasText: last.name }).nth(0);
  await expect(hit).toBeVisible();
  await expect.poll(() => asked).toContain(`/api/c/${last.id}/items`);
  release();
});

test("a message hit Cmd K lists is read before the owner picks it, so it opens at its message with no call in front of it", async ({ page }) => {
  await open(page, "#/c/ch_general");
  const ahead = page.waitForResponse((r) => new URL(r.url()).searchParams.has("around"));
  await page.keyboard.press("Control+k");
  const palette = page.locator("[data-search-palette]");
  await palette.getByRole("combobox").fill("relay");
  const hit = palette.locator('[data-key^="hit:"]').first();
  await expect(hit).toBeVisible();
  const around = new URL((await ahead).url());
  // Every hit listed is read, and one more turn of the page's loop keeps the answers.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));

  const asked: string[] = [];
  await page.route(held, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    asked.push(new URL(route.request().url()).search);
  });
  await hit.click();
  await expect(page).toHaveURL(/\?m=/);
  await expect(conversation(page).locator("[data-message-id]").first()).toBeVisible();
  expect(asked.some((search) => search.includes("around="))).toBe(true);
  expect(around.pathname).toMatch(/\/items$/);
});
