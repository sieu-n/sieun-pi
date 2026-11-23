import { HARNESS_AGENT, expect, resetFixture, test } from "./helpers";

/**
 * The socket's board event used to carry the whole board to every open page on each change: 219 KB of JSON for agent factory's board
 * on 11-23 (~/work/p231-slow-calls/p231-board-event). The page names the boards it holds when its socket opens, and an event for a board it holds is
 * what changed, which it applies to its kept board with no read.
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request, chatServer }) => { await resetFixture(request, chatServer); });

test("an agent's board change reaches an open board as what changed, and the page shows the server's board with no read", async ({ page, request, chatServer }) => {
  // helpers.ts routes the socket to the worker's server, which hides its frames from page.on("websocket"), so the page keeps them itself.
  await page.addInitScript(() => {
    const seen: string[] = ((window as unknown as { liveFrames: string[] }).liveFrames = []);
    window.WebSocket = class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", event => seen.push(String(event.data)));
      }
    };
  });
  const frames = async () => (await page.evaluate(() => (window as unknown as { liveFrames: string[] }).liveFrames))
    .filter(text => text.startsWith('{"type":"board"') && text.includes(`"chatId":"${HARNESS_AGENT}"`));
  const boardReads: string[] = [];
  page.on("request", r => {
    if (r.method() === "GET" && new URL(r.url()).pathname === `/api/agents/${HARNESS_AGENT}/board`) boardReads.push(r.url());
  });
  await page.goto(`/#/board/${HARNESS_AGENT}`);
  await expect(page.getByText("Pick the day for the production cutover.").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  const readsBefore = boardReads.length;

  const step = "Move the night alerts to the pager channel.";
  const added = await request.post(`${chatServer}/api/agents/${HARNESS_AGENT}/board`, { data: { actor: "agent", ops: [{ op: "plan_add", text: step }] } });
  expect(added.ok()).toBe(true);
  await expect(page.getByText(step).first()).toBeVisible();
  await page.waitForTimeout(500);

  const got = await frames();
  expect(got.length).toBeGreaterThan(0);
  const event = JSON.parse(got.at(-1)!) as { board?: unknown; delta?: { plan: { text: string }[] } };
  expect(event.board).toBeUndefined();
  expect(event.delta?.plan.map(item => item.text)).toContain(step);
  expect(boardReads.slice(readsBefore)).toEqual([]);

  // The kept board the page built from the delta is the server's board.
  const server = await (await request.get(`${chatServer}/api/agents/${HARNESS_AGENT}/board`)).json();
  const kept = await page.evaluate(path => new Promise<unknown>((resolve, reject) => {
    const open = indexedDB.open("chat.pages");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const all = open.result.transaction("pages").objectStore("pages").getAll();
      all.onsuccess = () => resolve((all.result as { cache: string; key: string; value: unknown }[]).find(p => p.cache === "kept" && p.key === path)?.value);
    };
  }), `/api/agents/${HARNESS_AGENT}/board`);
  expect(kept).toEqual(server);
});
