import type { Page } from "@playwright/test";
import { HARNESS_AGENT, expect, resetFixture, test } from "./helpers";

/**
 * What a reopen of the live socket reads again. On 11-28 the owner's socket reopened 6 times in 30 minutes; each reopen read GET /api/later
 * 3 times, once per Saved tab, and read his open board over the socket again, agent factory's 122 KB with br, while it had not changed
 * (~/work/p155-own-waits/summary.md). The page's socket is wrapped so a test can close it, read its frames and hold its board events back.
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request, chatServer }) => { await resetFixture(request, chatServer); });

const AGENT = `/api/agents/${HARNESS_AGENT}`;

type Frame = { out: boolean; text: string };
const WRAP = () => {
  const w = window as unknown as { __frames: Frame[]; __sockets: WebSocket[]; __holdBoards: boolean };
  w.__frames = [];
  w.__sockets = [];
  w.__holdBoards = false;
  class Wrapped extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      w.__sockets.push(this);
    }
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      w.__frames.push({ out: true, text: String(data) });
      super.send(data);
    }
    override set onmessage(handler: ((event: MessageEvent) => void) | null) {
      super.onmessage = handler && ((event: MessageEvent) => {
        const text = String(event.data);
        if (w.__holdBoards && text.startsWith('{"type":"board"')) return;
        w.__frames.push({ out: false, text });
        handler.call(this, event);
      });
    }
    override get onmessage(): ((event: MessageEvent) => void) | null {
      return super.onmessage;
    }
  }
  window.WebSocket = Wrapped;
};

const frames = (page: Page) => page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
/** Closes the page's open socket, as a dropped network does, and waits for the next one to open. */
async function reopen(page: Page): Promise<void> {
  const before = await page.evaluate(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.length);
  await page.evaluate(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.at(-1)!.close());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.filter(s => s.readyState === 1).length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.length)).toBeGreaterThan(before);
}
/** The socket reads the page sent for `path` since frame `from`, each with the answer the server sent. */
async function socketReads(page: Page, path: string, from: number): Promise<{ tag?: string; same?: true; value?: unknown }[]> {
  const all = (await frames(page)).slice(from);
  const sent = all.filter(f => f.out).map(f => JSON.parse(f.text) as { type: string; id: number; path: string; tag?: string }).filter(c => c.type === "read" && c.path === path);
  const answers = all.filter(f => !f.out && f.text.startsWith('{"type":"answer"')).map(f => JSON.parse(f.text) as { id: number; same?: true; value?: unknown });
  return sent.map(read => ({ ...(read.tag ? { tag: read.tag } : {}), ...answers.find(a => a.id === read.id) }));
}

test("a reopen reads Saved once, and its three tabs still list their rows", async ({ page, request, chatServer }) => {
  const posts = ((await (await request.get(`${chatServer}/api/c/ch_cutover/items`)).json()) as { items: { id: string; kind: string }[] }).items
    .filter(item => item.kind === "message" && item.id.startsWith("p")).slice(-3).map(item => item.id);
  expect(posts).toHaveLength(3);
  for (const post of posts) expect((await request.post(`${chatServer}/api/later`, { data: { room: "ch_cutover", post } })).ok()).toBe(true);
  await request.patch(`${chatServer}/api/later/ch_cutover:${posts[1]}`, { data: { state: "archived" } });
  await request.patch(`${chatServer}/api/later/ch_cutover:${posts[2]}`, { data: { state: "done" } });

  await page.addInitScript(WRAP);
  const reads: string[] = [];
  page.on("request", r => {
    if (r.method() === "GET" && new URL(r.url()).pathname === "/api/later") reads.push(r.url());
  });
  await page.goto("/#/c/saved");
  const tabs = page.getByTestId("later-page");
  await expect(tabs.locator(`[data-later-id="ch_cutover:${posts[0]}"]`)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_000);
  // The load's read and the first hello's, which reads what the socket may have missed before it opened.
  expect(reads.length).toBeLessThanOrEqual(2);

  const before = reads.length;
  await reopen(page);
  await expect.poll(() => reads.length).toBeGreaterThan(before);
  await page.waitForTimeout(1_000);
  expect(reads).toHaveLength(before + 1);

  await tabs.getByRole("tab", { name: "Archived" }).click();
  await expect(tabs.locator(`[data-later-id="ch_cutover:${posts[1]}"]`)).toBeVisible();
  await tabs.getByRole("tab", { name: "Completed" }).click();
  await expect(tabs.locator(`[data-later-id="ch_cutover:${posts[2]}"]`)).toBeVisible();
});

test("a reopen reads an open board and its duties over the socket with no answer when they did not change", async ({ page }) => {
  await page.addInitScript(WRAP);
  await page.goto(`/#/board/${HARNESS_AGENT}`);
  await expect(page.getByRole("region", { name: "Duties" })).toContainText("Relay uptime", { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  const from = (await frames(page)).length;
  await reopen(page);
  await expect.poll(async () => (await socketReads(page, `${AGENT}/board`, from)).filter(read => "same" in read || "value" in read)).toHaveLength(1);
  await expect.poll(async () => (await socketReads(page, `${AGENT}/duties`, from)).filter(read => "same" in read || "value" in read)).toHaveLength(1);
  for (const path of [`${AGENT}/board`, `${AGENT}/duties`]) {
    const [read] = await socketReads(page, path, from);
    expect(read!.same, path).toBe(true);
    expect(read!.value, path).toBeUndefined();
  }
  await expect(page.getByRole("region", { name: "Duties" })).toContainText("Relay uptime");
});

test("a reopen brings a board change the page missed while its socket was down", async ({ page, request, chatServer }) => {
  await page.addInitScript(WRAP);
  await page.goto(`/#/board/${HARNESS_AGENT}`);
  await expect(page.getByRole("region", { name: "Duties" })).toContainText("Relay uptime", { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  // The page misses the change's event, as a page whose socket was down does.
  await page.evaluate(() => { (window as unknown as { __holdBoards: boolean }).__holdBoards = true; });
  const step = "Move the night alerts to the pager channel.";
  expect((await request.post(`${chatServer}${AGENT}/board`, { data: { actor: "agent", ops: [{ op: "plan_add", text: step }] } })).ok()).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.getByText(step)).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __holdBoards: boolean }).__holdBoards = false; });
  const from = (await frames(page)).length;
  await reopen(page);
  await expect(page.getByText(step).first()).toBeVisible();
  const [read] = await socketReads(page, `${AGENT}/board`, from);
  expect(read?.same).toBeUndefined();
});
