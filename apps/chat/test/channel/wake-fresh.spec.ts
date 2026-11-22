import { createServer, connect, type Server, type Socket } from "node:net";
import { expect, test } from "@playwright/test";
import { open, tag } from "./helpers";

/**
 * A network that drops packets, as a Mac asleep or a tailnet coming back after a wake does, closes no socket. The live socket stays open,
 * the events sent meanwhile wait in TCP's retries, and the page showed the panels of before until a retry came: in the wake walk at a
 * 200 ms round trip (scripts/wake-walk.mjs, ~/work/p209-wake/before2.log), a message sent during a 5 s cut showed 2.5 s after the network
 * came back, and a test agent's board, whose events go to no page, never. Since p209 the page pings a quiet socket, drops one that does not
 * answer and opens a new one (live.svelte.ts), whose hello reads the open panels again.
 *
 * This spec puts the page's live socket through a relay that drops a 5 s cut the way TCP does: the bytes of a connection open at the cut
 * wait until `RETRANSMIT_MS` after the cut ends, and a connect made during the cut goes through at its next SYN retry, 1, 3, 7 or 15 s
 * after it started. The page's HTTP calls wait for the cut's end.
 */
const SERVER_PORT = Number(new URL(process.env.CHAT_SERVER_URL ?? "http://127.0.0.1:5186").port || 80);
/** When TCP's retry brought the held bytes after a 5 s cut in the wake walk: 2.53 s in Chromium and 2.56 s in WebKit (before2.log). */
const RETRANSMIT_MS = 2_500;
/** Linux's SYN retries after a connect's start, at its 1 s initial timeout doubled each time. */
const SYN_RETRIES_MS = [1_000, 3_000, 7_000, 15_000, 31_000];

/** One relayed connection; `held` keeps its bytes each way until TCP's retry would bring them. */
type Pair = { client: Socket; upstream: Socket | null; held: boolean; toServer: Buffer[]; toPage: Buffer[] };

class Cut {
  private server: Server;
  private pairs = new Set<Pair>();
  private downAt: number | undefined;
  private backAt: number | undefined;
  private ended: () => void = () => undefined;
  /** Resolves when the cut ends; an HTTP call waits on it. */
  back: Promise<void> = Promise.resolve();
  port = 0;

  constructor() {
    this.server = createServer(client => this.accept(client));
  }

  listen(): Promise<void> {
    return new Promise(resolve => this.server.listen(0, "127.0.0.1", () => {
      this.port = (this.server.address() as { port: number }).port;
      resolve();
    }));
  }

  private accept(client: Socket): void {
    const pair: Pair = { client, upstream: null, held: false, toServer: [], toPage: [] };
    this.pairs.add(pair);
    client.on("error", () => undefined);
    client.on("close", () => {
      pair.upstream?.destroy();
      this.pairs.delete(pair);
    });
    client.on("data", chunk => (pair.held || !pair.upstream ? pair.toServer.push(chunk) : pair.upstream.write(chunk)));
    const startedAt = Date.now();
    const link = () => {
      if (client.destroyed) return;
      const upstream = connect(SERVER_PORT, "127.0.0.1");
      pair.upstream = upstream;
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => client.destroy());
      upstream.on("data", chunk => (pair.held ? pair.toPage.push(chunk) : client.write(chunk)));
      for (const chunk of pair.toServer.splice(0)) upstream.write(chunk);
    };
    if (this.downAt === undefined) return link();
    // A connect into the cut: its SYN goes through at the first retry after the cut ends.
    void this.back.then(() => {
      const retry = SYN_RETRIES_MS.find(ms => startedAt + ms >= this.backAt!) ?? SYN_RETRIES_MS.at(-1)!;
      setTimeout(link, Math.max(0, startedAt + retry - Date.now()));
    });
  }

  start(): void {
    this.downAt = Date.now();
    this.back = new Promise(resolve => (this.ended = resolve));
    for (const pair of this.pairs) pair.held = true;
  }

  /** Ends the cut: HTTP calls go now, and the held connections' bytes `RETRANSMIT_MS` later, as TCP's retry brings them. */
  end(): void {
    this.backAt = Date.now();
    const held = [...this.pairs].filter(pair => pair.held);
    setTimeout(() => {
      for (const pair of held) {
        pair.held = false;
        for (const chunk of pair.toPage.splice(0)) pair.client.write(chunk);
        for (const chunk of pair.toServer.splice(0)) pair.upstream?.write(chunk);
      }
    }, RETRANSMIT_MS);
    this.downAt = undefined;
    this.ended();
  }

  close(): void {
    for (const pair of this.pairs) {
      pair.client.destroy();
      pair.upstream?.destroy();
    }
    this.server.close();
  }
}

test("after a 5 s network cut the open room, its board and its duties show what changed within 2 s of the network's return", async ({ page, request }) => {
  test.setTimeout(90_000);
  const t = tag();
  const agent = (await (await request.post("/api/agents", { data: { name: `wake ${t}`, test: true, thinkingLevel: "low", brief: "A spec's test agent." } })).json()) as { id: string };
  expect(agent.id).toBeTruthy();
  await request.post(`/api/agents/${agent.id}/board`, { data: { ops: [{ op: "plan_add", text: `first step ${t}` }] } });
  const duty = { name: `wake duty ${t}`, ownerWords: "spec", goal: "spec", onMiss: "nothing", metrics: [{ key: "x", label: "x", op: "<=", target: 0 }], precheck: { command: ["true"], cwd: "/tmp" } };
  const set = (await (await request.post(`/api/agents/${agent.id}/duties`, { data: { action: "set", duty } })).json()) as { duties: { duty: { id: string; name: string } }[] };
  const dutyId = set.duties.find(row => row.duty.name === duty.name)!.duty.id;
  await request.post(`/api/agents/${agent.id}/duties`, { data: { action: "pause", duty: dutyId } });
  const room = (await (await request.post("/api/rooms", { data: { kind: "channel", name: `wake-${t}`, members: [], test: true } })).json()) as { id: string };
  await request.patch(`/api/rooms/${room.id}`, { data: { homeChat: agent.id } });
  // A reconnect's watch names the newest post the page holds, and the server sends the posts after it; a room with none gets none back.
  await request.post(`/api/c/${room.id}/send`, { data: { text: `before the cut ${t}`, requestId: `wake-before-${t}` } });

  const cut = new Cut();
  await cut.listen();
  try {
    await page.addInitScript(port => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = new URL(url, location.href);
          if (target.pathname === "/api/live") target.href = `ws://127.0.0.1:${port}/api/live`;
          super(target, protocols);
        }
      };
    }, cut.port);
    await page.route(url => url.pathname.startsWith("/api/"), async route => {
      await cut.back;
      await route.continue().catch(() => undefined);
    });
    await open(page, `#/c/${room.id}`);
    await page.getByTestId("board-button").click();
    const pane = page.getByTestId("board-pane");
    await expect(pane).toContainText(`first step ${t}`);
    await expect(pane).toContainText(duty.name);
    await expect(page.locator("section.conversation").getByText(`before the cut ${t}`)).toBeVisible();
    await page.waitForTimeout(1_000);

    cut.start();
    await page.waitForTimeout(1_000);
    await request.post(`/api/agents/${agent.id}/board`, { data: { ops: [{ op: "plan_add", text: `step in the cut ${t}` }] } });
    await request.post(`/api/agents/${agent.id}/duties`, { data: { action: "schedule", duty: dutyId, schedule: { kind: "daily", at: "21:37" } } });
    await request.post(`/api/c/${room.id}/send`, { data: { text: `message in the cut ${t}`, requestId: `wake-${t}` } });
    await page.waitForTimeout(4_000);
    const backAt = Date.now();
    cut.end();

    const shown = async (locator: ReturnType<typeof page.locator>) => {
      await locator.waitFor({ timeout: 10_000 });
      return Date.now() - backAt;
    };
    const after = await Promise.all([
      shown(pane.getByText(`step in the cut ${t}`)),
      shown(pane.getByText("Daily at 21:37")),
      shown(page.locator("section.conversation").getByText(`message in the cut ${t}`)),
    ]);
    test.info().annotations.push({ type: "ms after the network came back (board, duty, message)", description: after.join(", ") });
    for (const ms of after) expect(ms).toBeLessThan(2_000);
  } finally {
    cut.close();
    await request.patch(`/api/c/${room.id}`, { data: { archived: true } }).catch(() => undefined);
  }
});
