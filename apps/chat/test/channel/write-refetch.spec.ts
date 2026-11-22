import { expect, test, type Page } from "@playwright/test";
import { open, tag } from "./helpers";

/**
 * The read that follows one of the owner's writes, such as the member list after Add, is a call he waits on (client.ts `wroteNow`): it
 * leaves at once, while the page's reads ahead and the refresh of the page he looks at are still on their way or queued, and a kept panel
 * reads again instead of taking the answer of a read that left before the write. On 11-22 a Work tab remove read the agent's rooms as a
 * panel refresh in the lane, which could join a read sent before the remove (AgentConfigPanel.svelte `load`).
 */
declare global {
  interface Window { settled: Record<string, string>; ahead: (path: string) => void; page: (path: string) => void }
}

/** Holds every request to a path matching `match` until the returned function runs, and lists the ones that went out. */
async function hold(page: Page, match: RegExp): Promise<{ sent: string[]; release: () => void }> {
  const sent: string[] = [];
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(match, async (route) => {
    sent.push(new URL(route.request().url()).search);
    await gate;
    await route.fallback().catch(() => undefined);
  });
  return { sent, release };
}

/** Queues `n` reads ahead and one refresh of the page he looks at, all held, so the lane is full when the write lands. */
async function fill(page: Page, n: number): Promise<{ sent: string[]; release: () => void }> {
  const held = await hold(page, /\/api\/rooms\?held=/);
  await page.evaluate(async (n) => {
    const client = "/src/lib/api/client.ts";
    const { get } = await import(/* @vite-ignore */ client);
    window.settled = {};
    window.ahead = (path) => void get({ path }, { background: "ahead" }).then(() => (window.settled[path] = "ok"), (e: unknown) => (window.settled[path] = String(e)));
    window.page = (path) => void get({ path }, { background: "shown", first: true }).then(() => (window.settled[path] = "ok"));
    window.page("/api/rooms?held=page");
    for (let i = 0; i < n; i++) window.ahead(`/api/rooms?held=${i}`);
  }, n);
  await expect.poll(() => held.sent.length).toBeGreaterThan(0);
  return held;
}

test("the member list after Add reads at once while reads ahead and the page's refresh are on their way", async ({ page }) => {
  const t = tag();
  const agent = (await (await page.request.post("/api/agents", { data: { name: `refetch pick ${t}`, test: true } })).json()) as { id: string; name: string };
  const room = (await (await page.request.post("/api/rooms", { data: { kind: "channel", name: `refetch-${t}`, members: [], test: true } })).json()) as { id: string; name: string };
  await open(page, `#/c/${room.id}`);
  await page.waitForLoadState("networkidle");
  const count = page.getByTestId("channel-members");
  await expect(count).toHaveAttribute("aria-label", "Members, 1 member");
  await count.click();
  await page.getByTestId("members-add").click();
  const picker = page.getByRole("dialog", { name: `Add people to #${room.name}` });
  await picker.getByRole("searchbox").fill(agent.name);
  await picker.getByRole("option", { name: new RegExp(agent.name) }).click();

  const held = await fill(page, 12);
  const times: Record<string, number> = {};
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.request().method() === "POST" && path === `/api/rooms/${room.id}/members`) times.post = Date.now();
    if (r.request().method() === "GET" && path === `/api/c/${room.id}`) times.header ??= Date.now();
  });
  await picker.getByRole("button", { name: "Add", exact: true }).click();
  await expect(count).toHaveAttribute("aria-label", "Members, 2 members");
  await expect(page.getByText(`Added ${agent.name} to #${room.name}`)).toBeVisible();
  // Every read ahead and the page's refresh are still held: the refresh went past them, not after them.
  expect(await page.evaluate(() => Object.keys(window.settled))).toEqual([]);
  test.info().annotations.push({ type: "header after POST", description: `${times.header! - times.post!} ms` });
  held.release();
  await expect.poll(() => page.evaluate(() => Object.keys(window.settled).length)).toBe(13);
});

test("a kept panel's read asked as his write answered leaves at once and does not take a read sent before the write", async ({ page }) => {
  await open(page, "#/c/ch_general");
  await page.waitForLoadState("networkidle");
  // The panel's first read stays held; any later read of it passes.
  const panel: string[] = [];
  let releasePanel = (): void => undefined;
  const gate = new Promise<void>((resolve) => (releasePanel = resolve));
  await page.route(/\/api\/rooms\?test=1&panel=1$/, async (route) => {
    panel.push(route.request().url());
    if (panel.length > 1) return route.fallback();
    // The answer the server gave before the write: no room of it yet.
    await gate;
    await route.fulfill({ json: [] }).catch(() => undefined);
  });
  await page.evaluate(async () => {
    const keptModule = "/src/lib/api/kept.svelte.ts";
    const { kept } = await import(/* @vite-ignore */ keptModule);
    const entry = kept({ path: "/api/rooms?test=1&panel=1" });
    entry.set([]);
    // A panel refresh on its way since before the write, which the route holds.
    void entry.read();
  });
  await expect.poll(() => panel.length).toBe(1);
  const held = await fill(page, 6);
  // His write, a new test channel, then the panel's refresh in its answer's promise chain, as the Work tab reads its rooms after a remove.
  const name = `refetch-panel-${tag()}`;
  await page.evaluate(async (name) => {
    const client = "/src/lib/api/client.ts";
    const keptModule = "/src/lib/api/kept.svelte.ts";
    const { api } = await import(/* @vite-ignore */ client);
    const { kept } = await import(/* @vite-ignore */ keptModule);
    const entry = kept({ path: "/api/rooms?test=1&panel=1" });
    void api.createRoom({ kind: "channel", name, members: [], test: true })
      .then(() => entry.read())
      .then(() => (window.settled.panel = JSON.stringify((entry.value as { name: string }[]).some((room) => room.name === name))));
  }, name);
  // It read again, past the held first read, the held page refresh and the held reads ahead, and shows the room the write made.
  await expect.poll(() => page.evaluate(() => window.settled.panel)).toBe("true");
  expect(panel).toHaveLength(2);
  expect(await page.evaluate(() => Object.keys(window.settled))).toEqual(["panel"]);
  // The read sent before the write answers last and does not put the older list back.
  releasePanel();
  held.release();
  await expect.poll(() => page.evaluate(() => Object.keys(window.settled).length)).toBe(8);
  await page.waitForTimeout(300);
  expect(await page.evaluate(async (name) => {
    const keptModule = "/src/lib/api/kept.svelte.ts";
    const { kept } = await import(/* @vite-ignore */ keptModule);
    return (kept({ path: "/api/rooms?test=1&panel=1" }).value as { name: string }[]).some((room) => room.name === name);
  }, name)).toBe(true);
});

test("the Work tab's rooms read after a remove and its Undo is logged as a wait, not a refresh", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false;
  });
  const t = tag();
  const agent = (await (await page.request.post("/api/agents", { data: { name: `refetch work ${t}`, test: true } })).json()) as { id: string; name: string };
  const room = (await (await page.request.post("/api/rooms", { data: { kind: "channel", name: `refetch-work-${t}`, members: [agent.id], test: true } })).json()) as { id: string; name: string };
  await page.goto(`/#/agents/${agent.id}?section=work`);
  const rooms = page.getByRole("region", { name: "Rooms" });
  const chip = rooms.getByRole("button", { name: room.name, exact: true });
  await expect(chip).toBeVisible();
  await page.waitForLoadState("networkidle");
  const config = `/api/agents/${agent.id}/config`;
  const batches: { p: string; m: string; bg?: string }[][] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/timings")) batches.push((r.postDataJSON() as { samples: { p: string; m: string; bg?: string }[] }).samples);
  });
  const flush = async () => {
    const before = batches.length;
    await page.evaluate(() => dispatchEvent(new Event("pagehide")));
    await expect.poll(() => batches.length).toBeGreaterThan(before);
  };
  await flush();
  const from = batches.length;
  await rooms.getByRole("button", { name: `Remove ${agent.name} from #${room.name}` }).click();
  await expect(chip).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).last().click();
  await expect(chip).toBeVisible();
  await page.waitForLoadState("networkidle");
  await flush();
  const lines = batches.slice(from).flat();
  const writes = lines.filter((s) => s.p.startsWith(`/api/rooms/${room.id}/members`));
  const reads = lines.filter((s) => s.m === "GET" && s.p === config);
  expect(writes).toHaveLength(2);
  // One read after each write is his; a socket event's read of an unchanged panel after it may still be a refresh.
  expect(reads.filter((s) => !s.bg).length).toBeGreaterThanOrEqual(2);
});
