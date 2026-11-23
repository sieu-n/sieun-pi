import type { Page } from "@playwright/test";
import { VENT, expect, resetFixture, test } from "./helpers";

/**
 * A board change used to read GET /api/boards and GET /api/for-you again on every open page. On 11-21 the owner's Board list waited 391 to
 * 2,705 ms behind 5 to 8 For you reads at a time (requests/2026-11-21.jsonl). The board event now carries the chat's row and asks, and the
 * page swaps them into its kept answers, so these specs fail the test on any read of either list after the first.
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request, chatServer }) => { await resetFixture(request, chatServer); });

const VENT_AGENT = "ag_vent";
const LISTS = new Set(["/api/boards", "/api/for-you"]);
const sidebar = (page: Page) => page.locator('[data-testid="sidebar"][data-root="board"]');
const asks = (page: Page) => page.getByRole("list", { name: "For you asks" }).locator("li");

/** Counts the page's reads of the two lists from now on. */
function countReads(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && LISTS.has(path)) seen.push(path);
  });
  return seen;
}

test("a board change shows in For you and the Board sidebar with no read of either list", async ({ page, request, chatServer }) => {
  await page.goto("/#/board");
  await expect(sidebar(page).locator(`a[href="#/board/${VENT_AGENT}"]`)).toBeVisible();
  await page.evaluate(() => { location.hash = "#/c/for-you"; });
  await expect(asks(page)).toHaveCount(4);
  await page.waitForLoadState("networkidle");
  const reads = countReads(page);

  const added = await request.post(`${chatServer}/api/threads/${VENT}/board`, { data: { ops: [{ op: "todo_add", text: "Pick the alert channel for the night shift." }] } });
  expect(added.ok()).toBe(true);
  await expect(asks(page)).toHaveCount(5);
  await expect(asks(page).nth(0)).toContainText("Pick the alert channel for the night shift.");

  const done = await request.post(`${chatServer}/api/threads/${VENT}/board`, { data: { ops: [{ op: "todo_update", id: "t1", done: true, reply: "Page me" }] } });
  expect(done.ok()).toBe(true);
  await expect(asks(page)).toHaveCount(4);
  await page.evaluate(() => { location.hash = "#/board"; });
  await expect(sidebar(page).locator(`a[href="#/board/${VENT_AGENT}"]`)).toContainText("1");

  // Both kept lists match the server's own answers, in the same order.
  const server = async () => {
    const [boards, forYou] = await Promise.all([request.get(`${chatServer}/api/boards`), request.get(`${chatServer}/api/for-you`)]);
    return { boards: await boards.json(), forYou: (await forYou.json()).items };
  };
  const keptLists = () => page.evaluate(() => new Promise<{ boards: unknown; forYou: unknown }>((resolve, reject) => {
    const open = indexedDB.open("chat.pages");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const all = open.result.transaction("pages").objectStore("pages").getAll();
      all.onsuccess = () => {
        const kept = new Map((all.result as { cache: string; key: string; value: unknown }[]).filter(p => p.cache === "kept").map(p => [p.key, p.value]));
        resolve({ boards: kept.get("/api/boards"), forYou: kept.get("/api/for-you") });
      };
    };
  }));
  const want = await server();
  await expect.poll(keptLists).toEqual(want);
  expect(reads).toEqual([]);
});

test("a reload shows For you from the answer the last load kept while its read hangs", async ({ page }) => {
  await page.goto("/#/c/for-you");
  await expect(asks(page).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const shown = await asks(page).allTextContents();
  await page.route("**/api/for-you", () => undefined);
  await page.reload();
  await expect(asks(page)).toHaveText(shown);
  await expect(page.getByText("Loading For you")).toHaveCount(0);
});

test("a board change while the Board page is closed reaches the list the last load kept, so its next open shows it while the read hangs", async ({ page, request, chatServer }) => {
  const openAsks = async () => ((await (await request.get(`${chatServer}/api/boards`)).json()) as { chatId: string; openAsks: number }[]).find(row => row.chatId === VENT_AGENT)!.openAsks;
  const before = await openAsks();
  await page.goto("/#/board");
  await expect(sidebar(page).locator(`a[href="#/board/${VENT_AGENT}"]`)).toHaveAttribute("title", `Vent: ${before} ask${before === 1 ? "" : "s"} for you`);
  await page.waitForLoadState("networkidle");
  await page.goto("about:blank");
  await page.goto("/#/c/for-you");
  await expect(asks(page).first()).toBeVisible();
  const text = `Pick the pager rota for week ${Date.now()}.`;
  const added = await request.post(`${chatServer}/api/threads/${VENT}/board`, { data: { ops: [{ op: "todo_add", text }] } });
  expect(added.ok()).toBe(true);
  await expect(asks(page).filter({ hasText: text })).toHaveCount(1);
  await page.route("**/api/boards", () => undefined);
  await page.evaluate(() => { location.hash = "#/board"; });
  await expect(sidebar(page).locator(`a[href="#/board/${VENT_AGENT}"]`)).toHaveAttribute("title", `Vent: ${before + 1} asks for you`);
});
