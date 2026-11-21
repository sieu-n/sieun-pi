import { expect, type Page, test } from "@playwright/test";
import { conversation, open, row } from "./helpers";

/**
 * Opens that waited one round trip on 11-21, about 210 ms from Korea (d2 run of 11-22 06:30 KST, requests/2026-11-21.jsonl): a work
 * thread no list read ahead, a thread on a post with no replies yet, and the refresh of an opened room held behind the Hosts page's poll.
 * Each spec holds the reads the open asks for, so only the page's cache can fill the screen.
 */
const held = /\/api\/c\/[^/]+(\/items|\/replies\/[^/]+)?(\?.*)?$/;

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

/** Holds every GET whose path matches `match` and lists the paths asked for; none of them gets an answer. */
async function hang(page: Page, match: RegExp): Promise<string[]> {
  const asked: string[] = [];
  await page.route(match, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    asked.push(new URL(route.request().url()).pathname);
  });
  return asked;
}

test("an agent's work thread opens from the page's read ahead with no call in front of its rows", async ({ page, request }) => {
  const agents = (await (await request.get("/api/agents")).json()) as { kind: string; thread: string; conversation: number; archived: boolean }[];
  const work = agents.find((agent) => agent.kind === "chat" && !agent.archived && agent.conversation === 1)!.thread;
  await open(page, "#/c/ch_general");
  await expect.poll(() => keptPage(page, "timeline", work), { timeout: 30_000 }).toBe(true);

  const asked = await hang(page, held);
  await page.evaluate((id) => (location.hash = `#/c/${id}`), work);
  await expect(conversation(page).locator("[data-message-id]").first()).toBeVisible();
  expect(asked).toContain(`/api/c/${work}/items`);
});

test("Reply in thread on a post with no replies shows the post in the pane with no call in front of it", async ({ page, request }) => {
  const channel = (await (await request.get("/api/c/ch_cutover/items")).json()) as { items: { id: string; kind: string; text?: string; threadRoot?: string; thread?: { replies: number } }[] };
  const post = channel.items.find((item) => item.kind === "message" && !item.threadRoot && !item.thread?.replies && item.text)!;
  await open(page, "#/c/ch_cutover");
  const asked = await hang(page, /\/api\/c\/ch_cutover\/replies\/[^/]+$/);

  const shown = row(page, post.id);
  await shown.hover();
  await shown.getByRole("button", { name: "Reply in thread" }).click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane.locator(`[data-message-id="${post.id}"]`)).toBeVisible();
  expect(asked).toContain(`/api/c/ch_cutover/replies/${post.id}`);
});

test("the refresh of the room he opened goes while one of his calls is on its way", async ({ page }) => {
  await open(page, "#/c/ch_general");
  await page.waitForLoadState("networkidle");
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const later: string[] = [];
  await page.route(/\/api\/later(\?.*)?$/, async (route) => {
    later.push(route.request().url());
    await gate;
    await route.fallback().catch(() => undefined);
  });
  const refreshes: string[] = [];
  page.on("request", (r) => (r.url().includes("lane=page") ? refreshes.push(r.url()) : undefined));

  await page.evaluate(async () => {
    const client = "/src/lib/api/client.ts";
    const { api } = await import(/* @vite-ignore */ client);
    void api.later();
  });
  await expect.poll(() => later.length).toBe(1);
  await page.evaluate(async () => {
    const client = "/src/lib/api/client.ts";
    const { get } = await import(/* @vite-ignore */ client);
    void get({ path: "/api/rooms?lane=page" }, { background: "shown", first: true });
  });
  await expect.poll(() => refreshes.length).toBe(1);
  release();
});

test("a kept page that grew past the server's page refreshes with no change, and its older posts stay", async ({ page, request }) => {
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false;
  });
  const word = Math.random().toString(36).slice(2, 8);
  const room = (await (await request.post("/api/rooms", { data: { kind: "channel", name: `kept-grown-${word}`, members: [], test: true } })).json()) as { id: string };
  const send = async (text: string) => expect((await request.post(`/api/c/${room.id}/send`, { data: { text, requestId: crypto.randomUUID() } })).ok()).toBe(true);
  for (let n = 1; ; n++) {
    await send(`post ${n} ${word}`);
    if (n >= 2 && ((await (await request.get(`/api/c/${room.id}/items`)).json()) as { older?: string }).older) break;
  }
  const first = ((await (await request.get(`/api/c/${room.id}/items`)).json()) as { items: { id: string }[] }).items[0]!.id;
  await open(page, `#/c/${room.id}`);
  // Posts land while the room is open, so the page it keeps holds more than the server's newest page.
  for (const n of [1, 2, 3]) await send(`late ${n} ${word}`);
  await expect(conversation(page).getByText(`late 3 ${word}`)).toBeVisible();

  const samples: { p: string; bg?: string }[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/timings")) samples.push(...(r.postDataJSON() as { samples: { p: string; bg?: string }[] }).samples);
  });
  const refreshed = page.waitForResponse((r) => r.url().includes(`/api/c/${room.id}/items`));
  await page.evaluate(() => location.reload());
  await refreshed;
  await expect(row(page, first)).toBeAttached();
  const of = (path: string) => samples.filter((s) => s.p === path).map((s) => s.bg ?? "waited");
  await expect.poll(async () => {
    await page.evaluate(() => dispatchEvent(new Event("pagehide")));
    return of(`/api/c/${room.id}/items`);
  }).toEqual(["shown"]);
});
