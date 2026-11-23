import type { Locator, Page, Request } from "@playwright/test";
import WebSocket from "ws";
import { HARNESS_AGENT, expect, resetFixture, test } from "./helpers";

/**
 * The owner's board write answers with the whole board, and the socket's board event carries it too, so the page shows his change with no
 * read of the board. On 11-23 at 14:23 UTC his POST of agent factory's board took 1,501 ms, and a GET of the same board, asked as the
 * event came, waited in the lane behind it and then counted as 1,644 ms of his wait (~/work/p231-slow-calls/summary.md): each new board
 * value made the panel's store again, and each new store read the board.
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page, request, chatServer }) => {
  await resetFixture(request, chatServer);
  // A beacon's body cannot be read here, so each batch of timing lines goes out as the fetch the page falls back to.
  await page.addInitScript(() => { navigator.sendBeacon = () => false; });
});

type Line = { m: string; p: string; bg?: string };

/**
 * The page's timing lines (client.ts) of the calls it makes from now on, which the returned function collects. A read ahead of a panel
 * nobody shows (`bg` "ahead") goes after an agent's turn moves it up the list, so only the other reads are the page's reads of what it shows.
 */
async function linesFromNow(page: Page): Promise<() => Promise<Line[]>> {
  await page.evaluate(() => dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(300);
  const lines: Line[] = [];
  const take = (request: Request) => {
    if (request.url().endsWith("/api/timings")) lines.push(...(request.postDataJSON() as { samples: Line[] }).samples);
  };
  page.on("request", take);
  return async () => {
    // A page that made no call since has no batch to post.
    const posted = page.waitForRequest(r => r.url().endsWith("/api/timings"), { timeout: 3_000 }).catch(() => undefined);
    await page.evaluate(() => dispatchEvent(new Event("pagehide")));
    await posted;
    page.off("request", take);
    return lines;
  };
}

const shownReads = (lines: Line[], paths: (path: string) => boolean): string[] =>
  lines.filter(line => line.m === "GET" && paths(line.p) && line.bg !== "ahead").map(line => `${line.p} ${line.bg ?? "waited"}`);
const isBoard = (path: string) => path.endsWith("/board");

/**
 * Answers the ask t1 and waits for the write's answer, the open list's change and a second for any read it starts. The page names the board
 * it shows, so the answer is the one todo that changed, not the whole board.
 */
async function answer(page: Page, where: Locator): Promise<void> {
  const before = await where.locator(".ask-row").count();
  const written = page.waitForResponse(r => r.request().method() === "POST" && isBoard(new URL(r.url()).pathname));
  await where.getByRole("button", { name: "Friday 09:00" }).click();
  const response = await written;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { board?: unknown; delta?: { plan: unknown[]; todos: { id: string }[] } };
  expect(body.board).toBeUndefined();
  expect(body.delta?.todos.map(todo => todo.id)).toEqual(["t1"]);
  await expect(where.locator(".ask-row")).toHaveCount(before - 1);
  await page.waitForTimeout(1_000);
}

test("a board write on the board page shows its answer with no read of the board", async ({ page }) => {
  await page.goto(`/#/board/${HARNESS_AGENT}`);
  await expect(page.getByRole("region", { name: "For you" })).toContainText("Pick the day for the production cutover.");
  await page.waitForLoadState("networkidle");
  const lines = await linesFromNow(page);
  await answer(page, page.getByRole("region", { name: "For you" }));
  expect(shownReads(await lines(), isBoard)).toEqual([]);
});

test("a board write in a DM's board pane shows its answer with no read of the board", async ({ page }) => {
  await page.goto(`/#/c/dm_${HARNESS_AGENT.slice(3)}`);
  await page.getByTestId("board-button").click();
  const pane = page.getByTestId("board-pane");
  await expect(pane).toContainText("Pick the day for the production cutover.");
  await page.waitForLoadState("networkidle");
  const lines = await linesFromNow(page);
  await answer(page, pane);
  expect(shownReads(await lines(), isBoard)).toEqual([]);
});

test("an agent's board write reaches the open board with no read of it", async ({ page, request, chatServer }) => {
  await page.goto(`/#/board/${HARNESS_AGENT}`);
  await expect(page.getByRole("region", { name: "For you" })).toContainText("Pick the day for the production cutover.");
  await page.waitForLoadState("networkidle");
  const lines = await linesFromNow(page);
  const added = await request.post(`${chatServer}/api/agents/${HARNESS_AGENT}/board`, { data: { ops: [{ op: "todo_add", text: "Pick the night shift's alert channel." }] } });
  expect(added.ok()).toBe(true);
  await expect(page.getByRole("region", { name: "For you" })).toContainText("Pick the night shift's alert channel.");
  await page.waitForTimeout(1_000);
  expect(shownReads(await lines(), isBoard)).toEqual([]);
});

test("a Dismiss on For you shows its change with no read of For you or the board", async ({ page }) => {
  await page.goto("/#/c/for-you");
  const rows = page.getByRole("list", { name: "For you asks" }).locator("li");
  await expect(rows.filter({ hasText: "Vent" })).toHaveCount(1);
  await page.waitForLoadState("networkidle");
  const before = await rows.count();
  const lines = await linesFromNow(page);
  const vent = rows.filter({ hasText: "Vent" });
  await vent.hover();
  const written = page.waitForResponse(r => r.request().method() === "POST" && isBoard(new URL(r.url()).pathname));
  await vent.getByRole("button", { name: "Dismiss t1" }).click();
  expect((await written).ok()).toBe(true);
  await expect(rows).toHaveCount(before - 1);
  await page.waitForTimeout(1_000);
  expect(shownReads(await lines(), path => isBoard(path) || path === "/api/for-you")).toEqual([]);
});

test("a refresh of a board the page built from a write's answer counts as no wait when the server's board is the same", async ({ page, chatServer }) => {
  // From the write on, the socket's board events, which carry the server's whole board, are held back, so the page shows only the board it
  // built itself from the write's answer. The socket goes to the worker's server, as helpers.ts sends it.
  let holding = false;
  await page.routeWebSocket(/\/api\/live/, route => {
    const url = new URL(route.url());
    url.protocol = "ws:";
    url.host = new URL(chatServer).host;
    const upstream = new WebSocket(url.toString());
    const early: string[] = [];
    upstream.on("open", () => { for (const message of early.splice(0)) upstream.send(message); });
    upstream.on("message", data => {
      const text = String(data);
      if (!(holding && text.startsWith('{"type":"board"'))) route.send(text);
    });
    upstream.on("close", () => void route.close().catch(() => undefined));
    route.onMessage(message => (upstream.readyState === WebSocket.OPEN ? upstream.send(message) : early.push(String(message))));
    route.onClose(() => upstream.close());
  });
  await page.goto(`/#/board/${HARNESS_AGENT}`);
  const region = page.getByRole("region", { name: "For you" });
  await expect(region).toContainText("Pick the day for the production cutover.");
  await page.waitForLoadState("networkidle");
  holding = true;
  await answer(page, region);
  const lines = await linesFromNow(page);
  await page.evaluate(() => { location.hash = "#/agents"; });
  await expect(page.locator('[role="gridcell"]').first()).toBeVisible();
  const read = page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/agents/${HARNESS_AGENT}/board`);
  await page.evaluate(hash => { location.hash = hash; }, `#/board/${HARNESS_AGENT}`);
  await read;
  await page.waitForTimeout(500);
  const board = (await lines()).filter(line => line.m === "GET" && line.p === `/api/agents/${HARNESS_AGENT}/board`).map(line => line.bg ?? "waited");
  expect(board).toEqual(["shown"]);
});

test("the board the page keeps after a write is the board a read answers", async ({ page, request, chatServer }) => {
  await page.goto(`/#/board/${HARNESS_AGENT}`);
  await expect(page.getByRole("region", { name: "For you" })).toContainText("Pick the day for the production cutover.");
  await answer(page, page.getByRole("region", { name: "For you" }));
  const kept = () => page.evaluate(path => new Promise<unknown>((resolve, reject) => {
    const open = indexedDB.open("chat.pages");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const all = open.result.transaction("pages").objectStore("pages").getAll();
      all.onsuccess = () => resolve((all.result as { cache: string; key: string; value: unknown }[]).find(p => p.cache === "kept" && p.key === path)?.value);
    };
  }), `/api/agents/${HARNESS_AGENT}/board`);
  const server = await (await request.get(`${chatServer}/api/agents/${HARNESS_AGENT}/board`)).json();
  await expect.poll(kept).toEqual(server);
});
