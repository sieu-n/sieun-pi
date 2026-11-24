import { createServer, connect, type Server, type Socket } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
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

  private accepted = 0;

  private accept(client: Socket): void {
    this.accepted += 1;
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
      upstream.on("error", () => (pair.held ? undefined : client.destroy()));
      upstream.on("close", () => (pair.held ? undefined : client.destroy()));
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

  /**
   * The server side of every connection open now closes, and the page hears neither the close nor anything else on them, while new
   * connections go through: the case of a WebKit page on 11-22 whose network side delivered nothing for 15 s while a release's old server
   * closed its socket (~/work/apps-chat-restart/after13).
   */
  stallAndClose(): void {
    for (const pair of this.pairs) {
      pair.held = true;
      pair.upstream?.destroy();
    }
  }

  get connections(): number {
    return this.accepted;
  }

  close(): void {
    for (const pair of [...this.pairs]) {
      pair.client.destroy();
      pair.upstream?.destroy();
    }
    this.server.close();
  }
}

/** A test agent with a board step and a paused duty, and a test channel that shows the agent's board, with one post in it. */
async function scene(request: APIRequestContext, t: string): Promise<{ agent: string; duty: { id: string; name: string }; room: string }> {
  const agent = (await (await request.post("/api/agents", { data: { name: `wake ${t}`, test: true, thinkingLevel: "low", brief: "A spec's test agent." } })).json()) as { id: string };
  expect(agent.id).toBeTruthy();
  await request.post(`/api/agents/${agent.id}/board`, { data: { ops: [{ op: "plan_add", text: `first step ${t}` }] } });
  const duty = { name: `wake duty ${t}`, ownerWords: "spec", goal: "spec", onMiss: "nothing", metrics: [{ key: "x", label: "x", op: "<=", target: 0 }], precheck: { command: ["true"], cwd: "/tmp" } };
  const set = (await (await request.post(`/api/agents/${agent.id}/duties`, { data: { action: "set", duty } })).json()) as { duties: { duty: { id: string; name: string } }[] };
  const id = set.duties.find(row => row.duty.name === duty.name)!.duty.id;
  await request.post(`/api/agents/${agent.id}/duties`, { data: { action: "pause", duty: id } });
  const room = (await (await request.post("/api/rooms", { data: { kind: "channel", name: `wake-${t}`, members: [], test: true } })).json()) as { id: string };
  await request.patch(`/api/rooms/${room.id}`, { data: { homeChat: agent.id } });
  // A reconnect's watch names the newest post the page holds, and the server sends the posts after it; a room with none gets none back.
  await request.post(`/api/c/${room.id}/send`, { data: { text: `before the cut ${t}`, requestId: `wake-before-${t}` } });
  return { agent: agent.id, duty: { id, name: duty.name }, room: room.id };
}

/** Opens the room with its board pane, its live socket through `cut` and its HTTP calls held while `cut` is down. */
async function openThrough(page: Page, cut: Cut, room: string, t: string): Promise<void> {
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
  await open(page, `#/c/${room}`);
  await page.getByTestId("board-button").click();
  await expect(page.getByTestId("board-pane")).toContainText(`first step ${t}`);
  await expect(page.locator("section.conversation").getByText(`before the cut ${t}`)).toBeVisible();
  await page.waitForTimeout(1_000);
}

/**
 * Starts the page's own watch for each change, `[container selector, text]`, and answers a wait for the `Date.now()` at which each showed.
 * The page notes the time of the DOM change that showed it, on the machine's one clock: a locator's wait polls each 500 ms once it has
 * waited 270 ms (playwright-core's retryWithProgressAndBackoff), which added 30 to 470 ms to each time the test read on 11-24
 * (~/work/chat-specs-red/specs-red-channel-wake-fresh/notes.md).
 */
async function watchShown(page: Page, wanted: [string, string][]): Promise<(locators: Locator[]) => Promise<number[]>> {
  await page.evaluate(wanted => {
    const shown: (number | undefined)[] = wanted.map(() => undefined);
    const look = () => wanted.forEach(([selector, text], i) => {
      if (shown[i] === undefined && document.querySelector(selector)?.textContent?.includes(text)) shown[i] = Date.now();
    });
    (window as unknown as { __shown: typeof shown }).__shown = shown;
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
    look();
  }, wanted);
  return async locators => {
    await Promise.all(locators.map(locator => locator.waitFor({ timeout: 10_000 })));
    const shown = await page.evaluate(() => (window as unknown as { __shown: (number | undefined)[] }).__shown);
    return shown.map(at => at ?? Infinity);
  };
}

/** The ms a process's main thread has waited for a CPU while runnable: the second field of /proc/<pid>/schedstat (ns), 0 once it ended. */
const cpuWaited = (pid: number): number => {
  try {
    return Number(readFileSync(`/proc/${pid}/schedstat`, "utf8").split(" ")[1]) / 1e6;
  } catch {
    return 0;
  }
};

/** The Chrome renderers this test worker's browser runs: the processes under this one whose command line has `--type=renderer`. */
function renderers(): number[] {
  const kids = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      kids.set(ppid, [...(kids.get(ppid) ?? []), Number(name)]);
    } catch {
      // The process ended while the scan ran.
    }
  }
  const found: number[] = [];
  const walk = (pid: number): void => {
    for (const kid of kids.get(pid) ?? []) {
      try {
        if (readFileSync(`/proc/${kid}/cmdline`, "utf8").includes("--type=renderer")) found.push(kid);
      } catch {
        // The process ended while the scan ran.
      }
      walk(kid);
    }
  };
  walk(process.pid);
  return found;
}

/**
 * The CPU wait on a change's way to the screen, sampled each 50 ms: this test process, which runs the relay, plus the fixture server, which
 * answers the page's reads, plus the renderer that waited most, as the page's one renderer cannot be told from the browser's others. In a
 * run on 11-24 that took 15 s where a quiet one takes 8 s, the new socket opened 0.67 s after the network came back and the panels showed
 * 1.0 to 1.6 s after that, where they show 60 ms after it on a quiet box (~/work/chat-specs-red/specs-red-channel-wake-fresh/notes.md), so
 * each bound applies to the time less this wait, the way test/server/send.test.ts and handoff.test.ts subtract theirs.
 */
async function cpuWait(request: APIRequestContext): Promise<{ between: (from: number, to: number) => number; stop: () => void; pids: number[] }> {
  const server = ((await (await request.get("/api/ready")).json()) as { pid: number }).pid;
  const pids = [process.pid, server, ...renderers()];
  const samples: [number, number[]][] = [];
  const sample = () => samples.push([Date.now(), pids.map(cpuWaited)]);
  sample();
  const timer = setInterval(sample, 50);
  // The last sample at or before `at`, so a wait after the change showed never counts.
  const at = (when: number) => (samples.filter(([taken]) => taken <= when).at(-1) ?? samples[0])[1];
  return {
    pids,
    between: (from, to) => {
      const [start, end] = [at(from), at(to)];
      const waited = end.map((ms, i) => ms - start[i]);
      return waited[0] + waited[1] + Math.max(0, ...waited.slice(2));
    },
    stop: () => clearInterval(timer),
  };
}

/** Changes the board, the duty's time and the room while the page cannot hear it. */
async function change(request: APIRequestContext, s: { agent: string; duty: { id: string }; room: string }, t: string, at: string): Promise<void> {
  await request.post(`/api/agents/${s.agent}/board`, { data: { ops: [{ op: "plan_add", text: `step in the cut ${t}` }] } });
  await request.post(`/api/agents/${s.agent}/duties`, { data: { action: "schedule", duty: s.duty.id, schedule: { kind: "daily", at } } });
  await request.post(`/api/c/${s.room}/send`, { data: { text: `message in the cut ${t}`, requestId: `wake-${t}` } });
}

const changes = (page: Page, t: string, at: string): Locator[] => [
  page.getByTestId("board-pane").getByText(`step in the cut ${t}`),
  page.getByTestId("board-pane").getByText(`Daily at ${at}`),
  page.locator("section.conversation").getByText(`message in the cut ${t}`),
];

/** The same three changes for the page's own watch. */
const changeTexts = (t: string, at: string): [string, string][] => [
  ['[data-testid="board-pane"]', `step in the cut ${t}`],
  ['[data-testid="board-pane"]', `Daily at ${at}`],
  ["section.conversation", `message in the cut ${t}`],
];

test("after a 5 s network cut the open room, its board and its duties show what changed within 2 s of the network's return", async ({ page, request }) => {
  test.setTimeout(90_000);
  const t = tag();
  const s = await scene(request, t);
  const cut = new Cut();
  await cut.listen();
  try {
    await openThrough(page, cut, s.room, t);
    const shownAfter = await watchShown(page, changeTexts(t, "21:37"));
    const cpu = await cpuWait(request);
    cut.start();
    await page.waitForTimeout(1_000);
    await change(request, s, t, "21:37");
    await page.waitForTimeout(4_000);
    const backAt = Date.now();
    cut.end();
    const shown = await shownAfter(changes(page, t, "21:37")).finally(cpu.stop);
    const after = shown.map(at => at - backAt);
    const waited = shown.map(at => Math.round(cpu.between(backAt, at)));
    test.info().annotations.push({ type: "ms after the network came back (board, duty, message), and the CPU wait in them", description: `${after.join(", ")}; ${waited.join(", ")} (pids ${cpu.pids.join(" ")})` });
    after.forEach((ms, i) => expect(ms - waited[i]).toBeLessThan(2_000));
  } finally {
    cut.close();
    await request.patch(`/api/c/${s.room}`, { data: { archived: true } }).catch(() => undefined);
  }
});

test("a live socket whose server side closed while the page heard nothing on it is replaced, and the changes show within 4 s", async ({ page, request }) => {
  test.setTimeout(90_000);
  const t = tag();
  const s = await scene(request, t);
  const cut = new Cut();
  await cut.listen();
  try {
    await openThrough(page, cut, s.room, t);
    const shownAfter = await watchShown(page, changeTexts(t, "22:41"));
    const before = cut.connections;
    const cpu = await cpuWait(request);
    const closedAt = Date.now();
    cut.stallAndClose();
    await change(request, s, t, "22:41");
    // A page that waits for the socket's own close event never opens a new one: the held close never comes.
    const shown = await shownAfter(changes(page, t, "22:41")).finally(cpu.stop);
    const after = shown.map(at => at - closedAt);
    const waited = shown.map(at => Math.round(cpu.between(closedAt, at)));
    test.info().annotations.push({ type: "ms after the server closed the socket (board, duty, message), and the CPU wait in them", description: `${after.join(", ")}; ${waited.join(", ")} (pids ${cpu.pids.join(" ")})` });
    expect(cut.connections).toBeGreaterThan(before);
    // The ping waits 2 s of quiet and 1.5 s for its pong (live.svelte.ts), then a new socket opens and reads in about 0.5 s.
    after.forEach((ms, i) => expect(ms - waited[i]).toBeLessThan(4_500));
  } finally {
    cut.close();
    await request.patch(`/api/c/${s.room}`, { data: { archived: true } }).catch(() => undefined);
  }
});
