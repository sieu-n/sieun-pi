import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

/**
 * Reads around the live socket's open and hello. In a walk of live :5184 at a 200 ms round trip on 11-28 (work/p324-dup-reads/live/r4):
 * after a release's hand-over, 4 Chromium room opens waited 1.3 to 6.6 s on a header read over the new socket before they read over HTTP;
 * each load read owner-settings, Saved and the open room's header again over HTTP about 2 s later, when the socket opened; and a test
 * room's open read its header twice in the same millisecond.
 */

type Held = { drop: () => void; release: () => void };

/**
 * Routes the page's live socket. `drop` closes the first socket, and on the socket the page opens next everything the server sends, the
 * hello first, is held until `release`.
 */
async function holdSecondHello(page: Page): Promise<Held> {
  const held: Held = { drop: () => undefined, release: () => undefined };
  let sockets = 0;
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    const server = ws.connectToServer();
    const mine = ++sockets;
    let waiting: (string | Buffer)[] | null = mine === 2 ? [] : null;
    if (mine === 1) held.drop = () => ws.close();
    if (mine === 2) {
      held.release = () => {
        for (const message of waiting ?? []) ws.send(message);
        waiting = null;
      };
    }
    ws.onMessage((message) => server.send(message));
    // Pongs go through, so the page keeps the socket while the rest waits.
    server.onMessage((message) => (waiting && !String(message).includes('"type":"pong"') ? waiting.push(message) : ws.send(message)));
  });
  return held;
}

const gets = (page: Page, paths: string[]): string[] => {
  const seen: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === "GET" && paths.includes(path)) seen.push(path);
  });
  return seen;
};

const go = async (page: Page, room: string, title: string) => {
  await page.evaluate((id) => { location.hash = `#/c/${id}`; }, room);
  await expect(page.getByTestId("conversation-title")).toContainText(title);
};

test("a room opened before the socket's hello reads over HTTP at once, not behind the socket", async ({ page }) => {
  const held = await holdSecondHello(page);
  const room = "ch_general";
  await open(page, "#/c/ch_cutover");
  await page.waitForLoadState("networkidle");
  // The socket drops and opens again, and the new socket's hello and every answer after it are held. A read of the room now marks it
  // current, since it left after the open.
  const reopened = page.waitForEvent("websocket");
  held.drop();
  await reopened;
  await page.waitForTimeout(500);
  const read = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/c/${room}/items`);
  await go(page, room, "general");
  await read;
  await page.waitForTimeout(300);
  await go(page, "ch_cutover", "pi-cutover");
  const headers = gets(page, [`/api/c/${room}`]);
  await go(page, room, "general");
  await expect.poll(() => headers.length, { timeout: 5000 }).toBe(1);
  held.release();
});

test("a page load reads Saved, the owner's settings and the open room's header once over HTTP, though the socket opens after", async ({ page }) => {
  const room = "ch_general";
  const seen = gets(page, ["/api/later", "/api/owner-settings", `/api/c/${room}`]);
  const hello = page.waitForEvent("websocket").then((ws) => ws.waitForEvent("framereceived", { predicate: (f) => String(f.payload).includes('"type":"hello"') }));
  await open(page, `#/c/${room}`);
  await hello;
  await page.waitForTimeout(1500);
  expect(seen.filter((p) => p === "/api/later")).toHaveLength(1);
  expect(seen.filter((p) => p === "/api/owner-settings")).toHaveLength(1);
  expect(seen.filter((p) => p === `/api/c/${room}`)).toHaveLength(1);
});

test("a test room's open reads its header once", async ({ page, request }) => {
  const made = (await (await request.post("/api/rooms", { data: { name: `hello-reads-${Math.random().toString(36).slice(2, 8)}`, kind: "channel", test: true } })).json()) as { id: string };
  await open(page, "#/c/ch_general");
  await page.waitForTimeout(1000);
  const headers = gets(page, [`/api/c/${made.id}`]);
  await page.evaluate((id) => { location.hash = `#/c/${id}`; }, made.id);
  await expect(page.getByTestId("conversation-title")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(headers).toHaveLength(1);
  await request.patch(`/api/c/${made.id}`, { data: { archived: true } });
});

test("a test room loaded first reads its header once, also after the sidebar comes with the socket's hello", async ({ page, request }) => {
  const made = (await (await request.post("/api/rooms", { data: { name: `hello-reads-${Math.random().toString(36).slice(2, 8)}`, kind: "channel", test: true } })).json()) as { id: string };
  const headers = gets(page, [`/api/c/${made.id}`]);
  // The hello, which brings the sidebar, comes after the timeline read the header, as at a 200 ms round trip on 11-28 (live/r5).
  let release = () => {};
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    const server = ws.connectToServer();
    let waiting: (string | Buffer)[] | null = [];
    release = () => {
      for (const message of waiting ?? []) ws.send(message);
      waiting = null;
    };
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => (waiting ? waiting.push(message) : ws.send(message)));
  });
  const read = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/c/${made.id}`);
  await page.goto(`/#/c/${made.id}`);
  await read;
  await page.waitForTimeout(300);
  release();
  await expect(page.getByTestId("conversation-title")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(headers).toHaveLength(1);
  await request.patch(`/api/c/${made.id}`, { data: { archived: true } });
});
