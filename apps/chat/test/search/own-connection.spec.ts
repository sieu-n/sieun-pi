import { expect, test } from "@playwright/test";
import { open } from "../channel/helpers";

/**
 * The calls the owner waits on, such as a Cmd K search, go with credentials "omit", which Chrome sends on an HTTP/2 connection of their
 * own, so they never queue behind the bytes of a read ahead already on its way. On 11-21 at 21:38:42 UTC his search, a 16 ms handler,
 * took 292 ms on the network right behind a read ahead of a two round trip page (client.ts, `ownConnection`).
 */
declare global {
  interface Window { fetched: { url: string; credentials: RequestCredentials | undefined }[] }
}

test("a search goes on the owner's own connection, and a read ahead stays on the page's", async ({ page }) => {
  await page.addInitScript(() => {
    window.fetched = [];
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      window.fetched.push({ url: String(input instanceof Request ? input.url : input), credentials: init?.credentials });
      return original(input, init);
    };
  });
  await open(page, "#/c/ch_general");
  await page.waitForLoadState("networkidle");
  // The page opens its own connection with one small call at boot, before it sends his calls on it.
  expect(await page.evaluate(() => window.fetched.filter(f => f.url === "/api/me" && f.credentials === "omit").length)).toBe(1);
  await page.evaluate(async () => {
    const { api, get } = await import(/* @vite-ignore */ "/src/lib/api/client.ts");
    await Promise.all([api.search({ q: "own-connection", limit: 5, brief: true }), get({ path: "/api/rooms?own=1" }, { background: "ahead" })]);
  });
  const sent = await page.evaluate(() => window.fetched.filter(f => f.url.includes("own-connection") || f.url.includes("own=1")));
  expect(sent.find(f => f.url.startsWith("/api/search"))?.credentials).toBe("omit");
  expect(sent.find(f => f.url.includes("own=1"))?.credentials).toBeUndefined();
});
