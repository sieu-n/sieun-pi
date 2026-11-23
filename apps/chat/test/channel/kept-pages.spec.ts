import { expect, test, type Page, type Request } from "@playwright/test";
import { conversation, open, tag } from "./helpers";

/**
 * A new release reloads the page when the owner switches away (reload.ts). On 11-20, 197 ms from the box, four such loads from 06:43 to
 * 06:58 KST each waited 204 to 222 ms for the room's items and for the replies of the thread that was open, with nothing on the screen.
 * The page now keeps its pages in IndexedDB (page-db.ts), so a load shows them at once, and it reads ahead the rooms Cmd K lists.
 */
const held = /\/api\/c\/[^/]+(\/items|\/replies\/[^/]+)?(\?.*)?$/;

/** The pages IndexedDB holds for the next page load (page-db.ts), each with its value as JSON. */
const keptPages = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ cache: string; key: string; json: string }[]>((resolve, reject) => {
        const request = indexedDB.open("chat.pages");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const all = request.result.transaction("pages").objectStore("pages").getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            request.result.close();
            resolve((all.result as { cache: string; key: string; value: unknown }[]).map((kept) => ({ cache: kept.cache, key: kept.key, json: JSON.stringify(kept.value) })));
          };
        };
      }),
  );

/** Whether IndexedDB holds the page of `cache` under a key `key` accepts, with `text` in it. */
const keeps = async (page: Page, cache: string, key: (key: string) => boolean, text: string) =>
  (await keptPages(page)).some((kept) => kept.cache === cache && key(kept.key) && kept.json.includes(text));

type Sample = { p: string; bg?: string };

/** The timing lines the page posts from now on; the spec turns `sendBeacon` off, so each batch is a fetch. */
const timings = (page: Page): Sample[] => {
  const samples: Sample[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/timings")) samples.push(...(r.postDataJSON() as { samples: Sample[] }).samples);
  });
  return samples;
};

/** Sends the page's batch of timing lines, as it does when the page goes away. */
const flush = (page: Page) => page.evaluate(() => dispatchEvent(new Event("pagehide")));

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
  await expect.poll(() => keeps(page, "timeline", (key) => key === "ch_general", '"kind":"message"')).toBe(true);
  await expect.poll(() => keeps(page, "replies", (key) => key.startsWith("ch_general\u0000"), '"root":{')).toBe(true);

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
  // The page asks for Later and the read mark first, so the refreshes may leave just after the kept pages show.
  await expect.poll(() => asked).toContain("/api/c/ch_general/items");
  await expect.poll(() => asked.some((path) => path.startsWith("/api/c/ch_general/replies/"))).toBe(true);

  const refreshed = Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/c/ch_general/items")),
    page.waitForResponse((r) => r.url().includes("/api/c/ch_general/replies/")),
  ]);
  const samples = timings(page);
  release();
  await refreshed;
  const logged = (path: (p: string) => boolean) => samples.some((s) => path(s.p));
  await expect
    .poll(async () => {
      await flush(page);
      return ["/api/c/ch_general/items", "/api/c/ch_general"].every((path) => logged((p) => p === path)) && logged((p) => p.startsWith("/api/c/ch_general/replies/"));
    })
    .toBe(true);
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

test("a message hit Cmd K lists is read before the owner picks it, so it opens at its message with no call in front of it", async ({ page, request }) => {
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false;
  });
  // Its own room and post, so the list holds one hit and the reads to wait for are this room's alone: on the shared fixture server other
  // specs' posts and the fixture agents' replies kept the page's network busy, and a wait for network idle ran out at 30 s.
  const word = `hit${tag()}`;
  const room = (await (await request.post("/api/rooms", { data: { kind: "channel", name: `kept-hit-${word}`, members: [] } })).json()) as { id: string };
  const sent = await request.post(`/api/c/${room.id}/send`, { data: { text: `a post ${word}`, requestId: crypto.randomUUID() } });
  expect(sent.ok()).toBe(true);
  const reads = { started: 0, answered: 0, failed: 0 };
  const ofRoom = (r: Request) => r.method() === "GET" && [`/api/c/${room.id}`, `/api/c/${room.id}/items`].includes(new URL(r.url()).pathname);
  page.on("request", (r) => void (ofRoom(r) && reads.started++));
  page.on("requestfinished", (r) => void (ofRoom(r) && reads.answered++));
  page.on("requestfailed", (r) => void (ofRoom(r) && reads.failed++));
  const samples = timings(page);
  await open(page, "#/c/ch_general");
  const ahead = page.waitForResponse((r) => r.url().includes(`/api/c/${room.id}/items`) && new URL(r.url()).searchParams.has("around"));
  await page.keyboard.press("Control+k");
  const palette = page.locator("[data-search-palette]");
  await palette.getByRole("combobox").fill(word);
  const hit = palette.locator('[data-key^="hit:"]');
  await expect(hit).toHaveCount(1);
  const around = new URL((await ahead).url());
  // Each read of a page is one items call and one header call. Once every call of the room answered, the page logged each, and each items
  // line has its header line, the page kept the page around the hit, in the turn its read logged its last line.
  await expect
    .poll(async () => {
      await flush(page);
      const lines = (path: string) => samples.filter((s) => s.p === path).length;
      const [items, header] = [lines(`/api/c/${room.id}/items`), lines(`/api/c/${room.id}`)];
      return reads.started === reads.answered + reads.failed && items + header === reads.answered && items > 0 && header >= items;
    })
    .toBe(true);

  const asked: string[] = [];
  await page.route(held, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    asked.push(new URL(route.request().url()).search);
  });
  await hit.click();
  await expect(page).toHaveURL(/\?m=/);
  await expect(conversation(page).getByText(`a post ${word}`)).toBeVisible();
  expect(asked.some((search) => search.includes("around="))).toBe(true);
  expect(around.pathname).toMatch(/\/items$/);
});

test("a reload after live posts shows them from the page it kept, so the reads behind it change nothing on the screen", async ({ page, request }) => {
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false;
  });
  const word = tag();
  const room = (await (await request.post("/api/rooms", { data: { kind: "channel", name: `kept-live-${word}`, members: [], test: true } })).json()) as { id: string };
  const send = async (text: string, threadRoot?: string) => {
    const response = await request.post(`/api/c/${room.id}/send`, { data: { text, requestId: crypto.randomUUID(), ...(threadRoot ? { threadRoot } : {}) } });
    expect(response.ok()).toBe(true);
  };
  await send(`root ${word}`);
  const root = ((await (await request.get(`/api/c/${room.id}/items`)).json()) as { items: { id: string }[] }).items[0]!.id;
  await send(`first reply ${word}`, root);
  await open(page, `#/c/${room.id}?thread=${root}`);
  const pane = page.getByTestId("thread-pane");
  await expect(pane.getByText(`first reply ${word}`)).toBeVisible();
  // The owner switches away, and agents post while he is away.
  await page.evaluate(() => dispatchEvent(new Event("blur")));
  await send(`later post ${word}`);
  await send(`later reply ${word}`, root);
  await expect(conversation(page).getByText(`later post ${word}`)).toBeVisible();
  await expect(pane.getByText(`later reply ${word}`)).toBeVisible();

  // A new release reloads the tab while he is away (reload.ts), with no event of its own before it goes.
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(held, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await gate;
    await route.fallback();
  });
  await expect.poll(() => keeps(page, "timeline", (key) => key === room.id, `later post ${word}`)).toBe(true);
  await expect.poll(() => keeps(page, "replies", (key) => key === `${room.id}\u0000${root}`, `later reply ${word}`)).toBe(true);
  await page.evaluate(() => location.reload());
  // The reload mounts the whole app again, as open() does, so it gets open()'s budget for a mount: in a run at box load 150 to 800 on
  // 11-23 the first open took 4.8 s and the reload 6.7 s until the kept page painted, with every read still held (trace of acpw-a4aa83).
  await expect(conversation(page).getByText(`later post ${word}`)).toBeVisible({ timeout: 15_000 });
  await expect(pane.getByText(`later reply ${word}`)).toBeVisible();

  const refreshed = Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/c/${room.id}/items`)),
    page.waitForResponse((r) => r.url().includes(`/api/c/${room.id}/replies/${root}`)),
  ]);
  const samples = timings(page);
  release();
  await refreshed;
  const of = (path: string) => samples.filter((s) => s.p === path).map((s) => s.bg ?? "waited");
  await expect
    .poll(async () => {
      await flush(page);
      return [of(`/api/c/${room.id}/items`), of(`/api/c/${room.id}/replies/${root}`)];
    })
    .toEqual([["shown"], ["shown"]]);
});

test("a room and a thread that got posts while the owner was elsewhere open with those posts, kept from the socket", async ({ page, request }) => {
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false;
  });
  const word = tag();
  const room = (await (await request.post("/api/rooms", { data: { kind: "channel", name: `kept-follow-${word}`, members: [] } })).json()) as { id: string };
  const send = async (text: string, threadRoot?: string) => {
    const response = await request.post(`/api/c/${room.id}/send`, { data: { text, requestId: crypto.randomUUID(), ...(threadRoot ? { threadRoot } : {}) } });
    expect(response.ok()).toBe(true);
  };
  await send(`root ${word}`);
  const root = ((await (await request.get(`/api/c/${room.id}/items`)).json()) as { items: { id: string }[] }).items[0]!.id;
  await send(`first reply ${word}`, root);
  await open(page, `#/c/${room.id}?thread=${root}`);
  const pane = page.getByTestId("thread-pane");
  await expect(pane.getByText(`first reply ${word}`)).toBeVisible();
  await page.evaluate(() => (location.hash = "#/c/ch_general"));
  await expect(conversation(page).locator("[data-message-id]").first()).toBeVisible();

  // Agents post in the room and its thread while he reads another one.
  await send(`later post ${word}`);
  await send(`later reply ${word}`, root);
  await expect.poll(() => keeps(page, "timeline", (key) => key === room.id, `later post ${word}`)).toBe(true);
  await expect.poll(() => keeps(page, "replies", (key) => key === `${room.id}\u0000${root}`, `later reply ${word}`)).toBe(true);

  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(held, async (route) => {
    if (route.request().method() !== "GET" || !route.request().url().includes(`/api/c/${room.id}`)) return route.fallback();
    await gate;
    await route.fallback();
  });
  const refreshed = Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/c/${room.id}/items`)),
    page.waitForResponse((r) => r.url().includes(`/api/c/${room.id}/replies/${root}`)),
  ]);
  await page.evaluate(([id, thread]) => (location.hash = `#/c/${id}?thread=${thread}`), [room.id, root]);
  await expect(conversation(page).getByText(`later post ${word}`)).toBeVisible();
  await expect(pane.getByText(`later reply ${word}`)).toBeVisible();

  const samples = timings(page);
  release();
  await refreshed;
  const last = (path: string) => samples.filter((s) => s.p === path).map((s) => s.bg ?? "waited").at(-1);
  await expect
    .poll(async () => {
      await flush(page);
      return [last(`/api/c/${room.id}/items`), last(`/api/c/${room.id}/replies/${root}`)];
    })
    .toEqual(["shown", "shown"]);
});

test("a channel he just made opens from the page its create call sent, with no read in front of it", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false;
  });
  await open(page, "#/c/new?kind=channel", "main-panel");
  const name = `fresh ${tag()}`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel(/Purpose/).fill("A fresh room");
  // Every read of a new channel hangs, so only the create call's own page can fill the screen.
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/c\/ch_[^/]+(\/items)?(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await gate;
    await route.fallback();
  });
  await page.getByTestId("main-panel").getByRole("button", { name: "Create channel" }).click();
  await expect(page).toHaveURL(/#\/c\/ch_/);
  const id = /#\/c\/(ch_[^/?]+)/.exec(page.url())![1]!;
  const slug = name.replace(" ", "-");
  await expect(page.getByTestId("conversation-title")).toHaveText(slug);
  await expect(page.getByTestId("channel-intro")).toContainText("A fresh room");

  const refreshed = page.waitForResponse((r) => r.url().includes(`/api/c/${id}/items`));
  const samples = timings(page);
  release();
  await refreshed;
  await expect
    .poll(async () => {
      await flush(page);
      return samples.filter((s) => s.p === `/api/c/${id}/items`).map((s) => s.bg ?? "waited");
    })
    .toEqual(["shown"]);
});
