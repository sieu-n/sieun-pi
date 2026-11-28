import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

/**
 * The lane in client.ts that every read ahead goes through. On 11-21 the owner's POST /read, a 4 ms handler, waited 1.1 to 4.7 s behind
 * the page's reads ahead, so a read ahead now never starts while one of his calls is on its way and stops when one starts. These drive
 * the page's own client module, the one the app runs, with reads ahead of paths the app itself never reads.
 */
type Lane = {
  later: () => Promise<unknown>;
  ahead: (path: string) => Promise<unknown>;
  keptAhead: (path: string) => Promise<unknown>;
  keptRead: (path: string) => Promise<unknown>;
  keptError: (path: string) => string | null;
};
declare global {
  interface Window { lane: Lane; settled: Record<string, string> }
}

/**
 * Keeps the page's own lane empty, so the test's calls are the only ones in it. The fixture is shared: with the live socket open, the hello
 * makes the page read ahead every room and board the other specs made (about 200 reads, 2 at once, 14 s at box load 250 on 11-23) and
 * read Later again, and those reads sat ahead of the test's in the lane. With no hello the page reads only what the open room shows.
 */
const noSocket = (page: Page) => page.routeWebSocket(/\/api\/live/, () => {});

async function lane(page: Page): Promise<void> {
  await noSocket(page);
  await open(page, "#/c/ch_general");
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    const client = "/src/lib/api/client.ts";
    const keptModule = "/src/lib/api/kept.svelte.ts";
    const { api, get } = await import(/* @vite-ignore */ client);
    const { kept } = await import(/* @vite-ignore */ keptModule);
    window.settled = {};
    const note = (path: string, promise: Promise<unknown>) => promise.then(() => (window.settled[path] = "ok"), (error: unknown) => (window.settled[path] = String(error)));
    window.lane = {
      later: () => note("later", api.later(undefined, true)),
      ahead: path => note(path, get({ path }, { background: "ahead" })),
      keptAhead: path => note(path, kept({ path }).ahead()),
      keptRead: path => note(`${path} read`, kept({ path }).read()),
      keptError: path => kept({ path }).error,
    };
  });
}

/** Holds every request to a path matching `match` until the returned function runs, and lists the ones that went out. */
async function hold(page: Page, match: RegExp): Promise<{ sent: string[]; release: () => void }> {
  const sent: string[] = [];
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(match, async (route) => {
    sent.push(new URL(route.request().url()).pathname + new URL(route.request().url()).search);
    await gate;
    await route.fallback().catch(() => undefined);
  });
  return { sent, release };
}

/** His call: GET /api/later?test=1, a read the page itself never makes on #/c/ch_general. */
const HIS = /\/api\/later\?test=1$/;

const settled = (page: Page, key: string) => page.evaluate((k) => window.settled[k], key);

test("no read ahead starts while a call the owner waits on is on its way", async ({ page }) => {
  await lane(page);
  const later = await hold(page, HIS);
  const rooms: string[] = [];
  page.on("request", (r) => (r.url().includes("lane=1") ? rooms.push(r.url()) : undefined));
  await page.evaluate(() => void window.lane.later());
  await expect.poll(() => later.sent.length).toBe(1);
  await page.evaluate(() => void window.lane.ahead("/api/rooms?lane=1"));
  await page.waitForTimeout(500);
  expect(rooms).toEqual([]);
  later.release();
  await expect.poll(() => settled(page, "later")).toBe("ok");
  await expect.poll(() => settled(page, "/api/rooms?lane=1")).toBe("ok");
  expect(rooms).toHaveLength(1);
});

test("a read ahead on its way stops when the owner's call starts, goes again after it, and logs no failure", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false;
  });
  const samples: { p: string; err?: string; bg?: string }[] = [];
  page.on("request", (r) => (r.url().endsWith("/api/timings") ? samples.push(...(r.postDataJSON() as { samples: typeof samples }).samples) : undefined));
  await lane(page);
  const aheadHeld = await hold(page, /\/api\/rooms\?lane=2$/);
  const failed: string[] = [];
  page.on("requestfailed", (r) => (r.url().includes("lane=2") ? failed.push(r.failure()?.errorText ?? "") : undefined));
  await page.evaluate(() => void window.lane.ahead("/api/rooms?lane=2"));
  await expect.poll(() => aheadHeld.sent.length).toBe(1);
  const later = await hold(page, HIS);
  await page.evaluate(() => void window.lane.later());
  await expect.poll(() => failed.length).toBe(1);
  expect(failed[0]).toContain("ABORTED");
  await page.waitForTimeout(300);
  // While his call is held, the stopped read ahead waits.
  expect(aheadHeld.sent).toHaveLength(1);
  later.release();
  await expect.poll(() => settled(page, "later")).toBe("ok");
  await expect.poll(() => aheadHeld.sent.length).toBe(2);
  aheadHeld.release();
  await expect.poll(() => settled(page, "/api/rooms?lane=2")).toBe("ok");

  // The page posts its timing lines every 10 s and the rest on pagehide, so the read's line may be in either batch.
  await page.evaluate(() => dispatchEvent(new Event("pagehide")));
  const rooms = () => samples.filter((s) => s.p === "/api/rooms" && s.bg === "ahead");
  await expect.poll(() => rooms().length).toBe(1);
  expect(rooms()[0]!.err).toBeUndefined();
});

test("a read ahead a view takes over leaves the lane: a queued one goes at once and one on its way is never stopped", async ({ page }) => {
  await lane(page);
  const failed: string[] = [];
  page.on("requestfailed", (r) => (r.url().includes("lane=") ? failed.push(r.url()) : undefined));

  // Queued behind his held call, then taken over by a panel that opens: it goes out while his call is still held.
  const later = await hold(page, HIS);
  const queued: string[] = [];
  page.on("request", (r) => (r.url().includes("lane=3") ? queued.push(r.url()) : undefined));
  await page.evaluate(() => void window.lane.later());
  await expect.poll(() => later.sent.length).toBe(1);
  await page.evaluate(() => void window.lane.keptAhead("/api/rooms?lane=3"));
  await page.waitForTimeout(300);
  expect(queued).toEqual([]);
  await page.evaluate(() => void window.lane.keptRead("/api/rooms?lane=3"));
  await expect.poll(() => queued.length).toBe(1);
  await expect.poll(() => settled(page, "/api/rooms?lane=3 read")).toBe("ok");
  later.release();
  await expect.poll(() => settled(page, "later")).toBe("ok");

  // On its way, then taken over, then his call starts: it is not stopped.
  const flying = await hold(page, /\/api\/rooms\?lane=4$/);
  await page.evaluate(() => void window.lane.keptAhead("/api/rooms?lane=4"));
  await expect.poll(() => flying.sent.length).toBe(1);
  await page.evaluate(() => void window.lane.keptRead("/api/rooms?lane=4"));
  await page.evaluate(() => void window.lane.later());
  await expect.poll(() => settled(page, "later")).toBe("ok");
  flying.release();
  await expect.poll(() => settled(page, "/api/rooms?lane=4 read")).toBe("ok");
  expect(flying.sent).toHaveLength(1);
  expect(failed).toEqual([]);
  expect(await page.evaluate(() => window.lane.keptError("/api/rooms?lane=4"))).toBeNull();
});

test("a new Cmd K list drops the queued reads of the rows it no longer shows", async ({ page }) => {
  await noSocket(page);
  await open(page, "#/c/ch_general");
  await page.waitForLoadState("networkidle");
  const hits: Record<string, string[]> = {};
  page.on("response", async (r) => {
    const url = new URL(r.url());
    if (url.pathname !== "/api/search" || !url.searchParams.get("q")) return;
    const body = (await r.json().catch(() => null)) as { hits: { conversation: { id: string }; messageId: string }[] } | null;
    if (body) hits[url.searchParams.get("q")!] = body.hits.map((hit) => `${hit.conversation.id}|${hit.messageId}`);
  });
  const around: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.searchParams.has("around")) around.push(`${decodeURIComponent(url.pathname.split("/")[3]!)}|${url.searchParams.get("around")}`);
  });
  // His call stays on its way, so every read ahead the palette asks for waits in the lane.
  const later = await hold(page, HIS);
  await page.evaluate(async () => {
    const client = "/src/lib/api/client.ts";
    const { api } = await import(/* @vite-ignore */ client);
    void api.later(undefined, true);
  });
  await expect.poll(() => later.sent.length).toBeGreaterThan(0);
  await page.keyboard.press("Control+k");
  const palette = page.locator("[data-search-palette]");
  await palette.getByRole("combobox").fill("relay");
  await expect.poll(() => hits.relay?.length ?? 0).toBeGreaterThan(0);
  await expect(palette.locator('[data-key^="hit:"]').first()).toBeVisible();
  await palette.getByRole("combobox").fill("board");
  await expect.poll(() => hits.board?.length ?? 0).toBeGreaterThan(0);
  await expect(palette.locator('[data-key^="hit:"]').first()).toBeVisible();
  await page.waitForTimeout(300);
  expect(around).toEqual([]);
  later.release();
  await expect.poll(() => around.length).toBeGreaterThan(0);
  await page.waitForLoadState("networkidle");
  const gone = hits.relay!.filter((hit) => !hits.board!.includes(hit));
  expect(gone.length).toBeGreaterThan(0);
  expect(around.filter((hit) => gone.includes(hit))).toEqual([]);
  expect(around.some((hit) => hits.board!.includes(hit))).toBe(true);
});

/**
 * Lists the Cmd K hits for `q` while his held call keeps every read ahead in the lane, and returns the hits as `conversation|message` and
 * the page reads around a message that went out.
 */
async function heldHits(page: Page, q: string): Promise<{ hits: string[]; around: string[]; release: () => void }> {
  await noSocket(page);
  await open(page, "#/c/ch_general");
  await page.waitForLoadState("networkidle");
  const hits: string[] = [];
  page.on("response", async (r) => {
    const url = new URL(r.url());
    if (url.pathname !== "/api/search" || url.searchParams.get("q") !== q) return;
    const body = (await r.json().catch(() => null)) as { hits: { conversation: { id: string }; messageId: string }[] } | null;
    if (body) hits.push(...body.hits.map((hit) => `${hit.conversation.id}|${hit.messageId}`));
  });
  const around: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.searchParams.has("around")) around.push(`${decodeURIComponent(url.pathname.split("/")[3]!)}|${url.searchParams.get("around")}`);
  });
  const later = await hold(page, HIS);
  await page.evaluate(async () => {
    const client = "/src/lib/api/client.ts";
    const { api } = await import(/* @vite-ignore */ client);
    void api.later(undefined, true);
  });
  await expect.poll(() => later.sent.length).toBeGreaterThan(0);
  await page.keyboard.press("Control+k");
  const palette = page.locator("[data-search-palette]");
  await palette.getByRole("combobox").fill(q);
  await expect.poll(() => hits.length).toBeGreaterThan(1);
  await expect(palette.locator('[data-key^="hit:"]').nth(1)).toBeVisible();
  return { hits, around, release: later.release };
}

// On 11-28 at 10:23 UTC his page read the pages around 21 Cmd K hits, 10 of them in one channel, 12 s after he picked a hit and the
// palette closed: his calls held the lane, and the closed palette still listed its rows (work/p324-dup-reads).
test("a closed Cmd K palette drops the queued reads of its hits", async ({ page }) => {
  const { around, release } = await heldHits(page, "board");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-search-palette]")).toBeHidden();
  await page.waitForTimeout(300);
  expect(around).toEqual([]);
  release();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  expect(around).toEqual([]);
});

test("a picked Cmd K hit reads only its own page", async ({ page }) => {
  const { hits, around, release } = await heldHits(page, "board");
  const palette = page.locator("[data-search-palette]");
  const picked = palette.locator('[data-key^="hit:"]').first();
  await picked.click();
  await expect(palette).toBeHidden();
  release();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  expect(around.length).toBeLessThanOrEqual(1);
  expect(around.every((hit) => hits.includes(hit))).toBe(true);
});

test("a refresh behind a shown panel goes beside the owner's call on its own connection, and the read ahead waits", async ({ page }) => {
  await lane(page);
  const order: string[] = [];
  page.on("request", (r) => (r.url().includes("lane=") ? order.push(new URL(r.url()).search) : undefined));
  const later = await hold(page, HIS);
  await page.evaluate(() => void window.lane.later());
  await expect.poll(() => later.sent.length).toBe(1);
  await page.evaluate(async () => {
    const keptModule = "/src/lib/api/kept.svelte.ts";
    const { kept } = await import(/* @vite-ignore */ keptModule);
    kept({ path: "/api/rooms?lane=6" }).set([]);
    void window.lane.ahead("/api/rooms?lane=5");
    void window.lane.keptRead("/api/rooms?lane=6");
  });
  await expect.poll(() => settled(page, "/api/rooms?lane=6 read")).toBe("ok");
  await page.waitForTimeout(300);
  expect(order).toEqual(["?lane=6"]);
  later.release();
  await expect.poll(() => settled(page, "/api/rooms?lane=5")).toBe("ok");
  expect(order).toEqual(["?lane=6", "?lane=5"]);
});

test("a read mark about to go holds the reads ahead, but no refresh", async ({ page }) => {
  await lane(page);
  const order: string[] = [];
  page.on("request", (r) => (r.url().includes("lane=") ? order.push(new URL(r.url()).search) : undefined));
  await page.evaluate(async () => {
    const client = "/src/lib/api/client.ts";
    const keptModule = "/src/lib/api/kept.svelte.ts";
    const { expectCall, get } = await import(/* @vite-ignore */ client);
    const { kept } = await import(/* @vite-ignore */ keptModule);
    (window as unknown as { release: () => void }).release = expectCall();
    kept({ path: "/api/rooms?lane=7" }).set([]);
    void window.lane.keptRead("/api/rooms?lane=7");
    void get({ path: "/api/rooms?lane=8" }, { background: "shown", first: true });
    void window.lane.ahead("/api/rooms?lane=9");
  });
  await expect.poll(() => [...order].sort()).toEqual(["?lane=7", "?lane=8"]);
  await page.waitForTimeout(300);
  expect(order).toHaveLength(2);
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await expect.poll(() => order).toHaveLength(3);
  expect(order[2]).toBe("?lane=9");
});

test("a panel refresh goes beside the refresh of the page he looks at", async ({ page }) => {
  await lane(page);
  const order: string[] = [];
  page.on("request", (r) => (r.url().includes("lane=") ? order.push(new URL(r.url()).search) : undefined));
  const pageRead = await hold(page, /\/api\/rooms\?lane=10$/);
  await page.evaluate(async () => {
    const client = "/src/lib/api/client.ts";
    const keptModule = "/src/lib/api/kept.svelte.ts";
    const { get } = await import(/* @vite-ignore */ client);
    const { kept } = await import(/* @vite-ignore */ keptModule);
    void get({ path: "/api/rooms?lane=10" }, { background: "shown", first: true });
    kept({ path: "/api/rooms?lane=11" }).set([]);
    void window.lane.keptRead("/api/rooms?lane=11");
  });
  await expect.poll(() => pageRead.sent.length).toBe(1);
  await expect.poll(() => settled(page, "/api/rooms?lane=11 read")).toBe("ok");
  expect(order).toEqual(["?lane=10", "?lane=11"]);
  pageRead.release();
});

test("a refresh leaves in the task that asks for it, with no wait for the next paint", async ({ page }) => {
  await lane(page);
  const left = await page.evaluate(async () => {
    const keptModule = "/src/lib/api/kept.svelte.ts";
    const { kept } = await import(/* @vite-ignore */ keptModule);
    kept({ path: "/api/rooms?lane=12" }).set([]);
    const sent: string[] = [];
    const fetched = window.fetch;
    window.fetch = (input, init) => {
      sent.push(String(input));
      return fetched(input, init);
    };
    void window.lane.keptRead("/api/rooms?lane=12");
    window.fetch = fetched;
    return sent;
  });
  expect(left).toEqual(["/api/rooms?lane=12"]);
  await expect.poll(() => settled(page, "/api/rooms?lane=12 read")).toBe("ok");
});
