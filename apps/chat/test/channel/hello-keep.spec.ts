import { expect, type Page, test } from "@playwright/test";
import { open } from "./helpers";

/**
 * The page keeps the hello's lists in IndexedDB so a reload's hello carries only the buckets that changed (web/src/lib/api/hello-keep.ts).
 * On 11-25 the page put both whole lists and digested them inside the hello's own task: 49 to 54 ms of a 157 to 172 ms task on a reload of
 * live :5184, and 1,111 ms at CPU rate 4 (~/work/p300-channel-open/trace-summary.md). These specs check that the hello's task writes
 * nothing to IndexedDB, and that what lands later still names every bucket, so the next hello stays partial.
 */

/** Logs each IndexedDB put of a hello record, and whether it ran in the task that dispatched a hello message. */
const HOOKS = () => {
  const w = window as unknown as { __helloTask: boolean; __helloPuts: { cache: string; key: string; inHello: boolean }[] };
  w.__helloTask = false;
  w.__helloPuts = [];
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const page = value as { cache?: unknown; key?: unknown } | null;
    if (typeof page?.cache === "string" && page.cache.startsWith("hello")) w.__helloPuts.push({ cache: page.cache, key: String(page.key), inHello: w.__helloTask });
    return put.call(this, value, key);
  };
  const Socket = WebSocket;
  const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const socket = new Socket(url, protocols);
    // Added before the page sets onmessage, so it runs first; the flag stays up until the task and its microtasks end.
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || !event.data.slice(0, 40).includes('"type":"hello"')) return;
      w.__helloTask = true;
      setTimeout(() => (w.__helloTask = false), 0);
    });
    return socket;
  } as unknown as typeof WebSocket;
  Wrapped.prototype = Socket.prototype;
  Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Wrapped;
};

type Put = { cache: string; key: string; inHello: boolean };
const puts = (page: Page) => page.evaluate(() => (window as unknown as { __helloPuts: Put[] }).__helloPuts);
const keptKeys = async (page: Page) => new Set((await puts(page)).filter((p) => p.cache === "hello-bucket").map((p) => p.key)).size;

test("the hello's task writes nothing to IndexedDB, and a reload names every kept bucket in its socket's URL", async ({ page }) => {
  await page.addInitScript(HOOKS);
  await open(page, "#/c/ch_cutover");
  // A first load gets the whole lists and keeps both lists' 256 buckets, in idle time after the hello.
  await expect.poll(async () => (await puts(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect((await puts(page)).filter((p) => p.inHello)).toEqual([]);
  await expect.poll(() => keptKeys(page), { timeout: 15_000 }).toBe(512);

  const socket = page.waitForEvent("websocket", (ws) => ws.url().includes("/api/live"));
  await page.reload();
  const ws = await socket;
  const hello = await ws.waitForEvent("framereceived", (frame) => typeof frame.payload === "string" && frame.payload.slice(0, 40).includes('"type":"hello"'));
  const url = new URL(ws.url());
  expect(url.searchParams.get("jobs")).toMatch(/^[0-9a-f]{2048}$/);
  expect(url.searchParams.get("conversations")).toMatch(/^[0-9a-f]{2048}$/);
  // The server took the kept digests, so the reload's hello is partial, and the buckets it changed go to IndexedDB outside its task too.
  expect(JSON.parse(String(hello.payload)).partial).toBeDefined();
  await expect(page.getByTestId("timeline").first()).toBeVisible();
  expect((await puts(page)).filter((p) => p.inHello)).toEqual([]);
});
