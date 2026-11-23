import { expect, test, type Page, type WebSocket } from "@playwright/test";

/**
 * A page load names the hello lists the last load kept in IndexedDB (stores.svelte.ts `restoreLists`), so its hello carries only the buckets
 * that changed. On 11-24 every load of live :5184 got the whole hello, 1.8 MB of JSON and 196 KB on the wire, 1.09 MB of it the 1,925 jobs,
 * because the lists the last hello brought lived in the page's memory only and a release reloads the page.
 */
const AGENT = "ag_vent";

type Hello = { type: "hello"; jobs: unknown[]; conversations: unknown[]; partial?: Record<string, number[]> };

const nextHello = (page: Page): Promise<{ url: string; hello: Hello }> => new Promise(resolve => {
  const take = (socket: WebSocket) => {
    if (!socket.url().includes("/api/live")) return;
    socket.on("framereceived", frame => {
      const event = JSON.parse(String(frame.payload)) as { type: string };
      if (event.type !== "hello") return;
      page.off("websocket", take);
      resolve({ url: socket.url(), hello: event as Hello });
    });
  };
  page.on("websocket", take);
});

const keptLists = (page: Page): Promise<number> => page.evaluate(() => new Promise<number>(resolve => {
  const open = indexedDB.open("chat.pages");
  open.onsuccess = () => {
    const get = open.result.transaction("pages").objectStore("pages").get(["hello", "hello"]);
    get.onsuccess = () => resolve((get.result?.value?.jobs as unknown[] | undefined)?.length ?? 0);
    get.onerror = () => resolve(0);
  };
  open.onerror = () => resolve(0);
}));

test("a reload's hello carries only the buckets that changed, and the page still counts every job", async ({ page, request }) => {
  const first = nextHello(page);
  await page.goto("/#/agents");
  const cold = await first;
  expect(new URL(cold.url).searchParams.has("jobs")).toBe(false);
  expect(cold.hello.partial).toBeUndefined();
  await expect.poll(() => keptLists(page)).toBe(cold.hello.jobs.length);

  const second = nextHello(page);
  await page.reload();
  const warm = await second;
  expect(new URL(warm.url).searchParams.get("jobs")).toMatch(/^[0-9a-f]{2048}$/);
  expect(warm.hello.partial).toBeDefined();
  expect(warm.hello.jobs.length).toBeLessThan(cold.hello.jobs.length);

  const jobs = (await (await request.get(`/api/jobs?agent=${AGENT}`)).json()) as unknown[];
  expect(jobs.length).toBeGreaterThan(0);
  await expect(page.getByRole("main")).toContainText(`${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`);
});
