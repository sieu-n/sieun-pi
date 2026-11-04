/**
 * The request log and the speed duty's precheck: the server writes one line per /api request with its route pattern, POST /api/timings
 * takes the web client's waits, an old day file goes, and `scripts/duties/api-speed.ts` reads each metric from the client's lines with the
 * server's as the fallback.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { apiSpeed, finding } from "../../scripts/duties/api-speed.ts";
import { LoopStalls, RequestLog, type RequestTiming } from "../../server/request-log.ts";
import { start } from "./helpers.ts";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "apps-chat-api-speed-"));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));

const lines = (dir: string): RequestTiming[] =>
  readdirSync(join(dir, "requests")).flatMap(name => readFileSync(join(dir, "requests", name), "utf8").trim().split("\n").map(line => JSON.parse(line) as RequestTiming));

test("the server logs each /api request by route and takes the client's waits", async () => {
  const dataDir = tempDir();
  const chat = await start({ dataDir });
  try {
    const sidebar = await chat.get("/api/sidebar");
    const room = sidebar.dms[0]?.id ?? sidebar.channels[0].id;
    await chat.get(`/api/c/${room}/items?limit=5`);
    const posted = await chat.send("POST", "/api/timings", { samples: [
      { m: "GET", p: `/api/c/${room}/items?limit=5`, s: 200, ms: 420, net: 12 },
      { m: "GET", p: "/api/search", s: 200, ms: 90, net: "fast" },
      { m: "GET", p: "/not-api", s: 200, ms: 1 },
      { m: "GET", p: "/api/me", s: 200, ms: "slow" },
    ] });
    assert.deepEqual(posted, { status: 200, body: { taken: 2 } });
    const viaTailnet = await fetch(`${chat.base}/api/timings`, {
      method: "POST", headers: { "content-type": "application/json", "tailscale-user-login": "owner@example.com" },
      body: JSON.stringify({ samples: [{ m: "GET", p: "/api/rooms", s: 200, ms: 30, net: 4 }] }),
    });
    assert.equal(viaTailnet.status, 200);
    await new Promise(resolve => setTimeout(resolve, 50));
    const logged = lines(dataDir);
    const server = logged.find(line => line.src === "server" && line.p === `/api/c/${room}/items`);
    assert.equal(server?.r, "/api/c/:id/items");
    assert.equal(server?.s, 200);
    assert.ok(server!.ms >= 0);
    assert.ok(!logged.some(line => line.p === "/api/timings"), "the timings post itself is not logged");
    const client = logged.filter(line => line.src === "client");
    assert.deepEqual(client.map(line => [line.r, line.p, line.ms, line.net, line.via]), [
      ["/api/c/:id/items", `/api/c/${room}/items`, 420, 12, "local"], ["/api/search", "/api/search", 90, undefined, "local"], ["/api/rooms", "/api/rooms", 30, 4, "tailnet"],
    ]);
  } finally {
    await chat.close();
  }
});

test("a server line splits its time into the body wait, the handler and the longest event-loop stall", async () => {
  const stalls = new LoopStalls();
  try {
    const since = performance.now();
    await new Promise(resolve => setTimeout(resolve, 40));
    const blocked = performance.now();
    while (performance.now() - blocked < 150) { /* holds the loop */ }
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(stalls.longest(since) >= 100, `a 150 ms block reads as a stall, got ${stalls.longest(since)}`);
  } finally {
    stalls.stop();
  }
  const dataDir = tempDir();
  const chat = await start({ dataDir });
  try {
    const room = (await chat.get("/api/sidebar")).dms[0].id;
    await chat.send("POST", `/api/c/${room}/read`, {});
    await new Promise(resolve => setTimeout(resolve, 50));
    const read = lines(dataDir).find(line => line.src === "server" && line.r === "/api/c/:id/read");
    assert.ok(read?.body !== undefined && read.run !== undefined && read.body + read.run <= read.ms + 0.2, JSON.stringify(read));
  } finally {
    await chat.close();
  }
});

test("a refused send logs its route, status and reason, and a page's failed call reaches the log", async () => {
  const dataDir = tempDir();
  const logs: string[] = [];
  const chat = await start({ dataDir, log: line => logs.push(line) });
  try {
    const channel = (await chat.get("/api/sidebar")).channels[0].id as string;
    const refused = await chat.send("POST", `/api/c/${channel}/send`, { text: "long post", requestId: "r-blob", images: [{ url: "blob:x", mimeType: "image/png" }] });
    assert.equal(refused.status, 400);
    const empty = await chat.send("POST", `/api/c/${channel}/send`, { text: " ", requestId: "r-empty" });
    assert.equal(empty.status, 400);
    const p = `/api/c/${channel}/send`;
    const samples = [
      { m: "POST", p, s: 0, ms: 7, err: "TypeError: Failed to fetch" },
      { m: "POST", p, s: 400, ms: 30, err: "No upload blob:x" },
      { m: "POST", p, s: 400, ms: 0, err: "No upload blob:x", shown: true },
      { m: "POST", p, s: 0, ms: 0, err: "TypeError: Failed to fetch", shown: true },
    ];
    assert.deepEqual(await chat.send("POST", "/api/timings", { samples }), { status: 200, body: { taken: 4 } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(logs.some(line => line.startsWith(`POST /api/c/:id/send ${p} 400: No upload blob:x;`)), logs.join("\n"));
    assert.ok(logs.includes(`POST /api/c/:id/send ${p} 400: A message needs text or an image.`), logs.join("\n"));
    assert.ok(logs.includes(`client POST /api/c/:id/send ${p} unreached (local): TypeError: Failed to fetch`), logs.join("\n"));
    assert.ok(logs.includes(`client POST /api/c/:id/send ${p} Not delivered (local): TypeError: Failed to fetch`), logs.join("\n"));
    const sends = lines(dataDir).filter(line => line.r === "/api/c/:id/send");
    assert.deepEqual(sends.map(line => [line.src, line.s, line.err?.slice(0, 15), line.shown]), [
      ["server", 400, "No upload blob:", undefined], ["server", 400, "A message needs", undefined], ["client", 0, "TypeError: Fail", undefined],
      ["client", 400, "No upload blob:", undefined], ["client", 400, "No upload blob:", true], ["client", 0, "TypeError: Fail", true],
    ]);
    // The two refusals and the send that never reached the server count; the unreached try and the page's copies of the refusal do not.
    const out = apiSpeed(dataDir, Date.now() + 1, 3600_000);
    assert.equal(out.metrics.failed_sends_24h, 3);
    const failed = out.flagged.filter(row => row.kind === "failed_send");
    assert.deepEqual(failed.map(row => row.sig), ["server:POST /api/c/:id/send:400", "server:POST /api/c/:id/send:400", "client:POST /api/c/:id/send:0"]);
    assert.match(failed[2]!.excerpt, /never reached the server \(client, Not delivered after the page's tries\): TypeError: Failed to fetch$/);
    assert.equal(out.routes.find(route => route.src === "client" && route.route === "POST /api/c/:id/send")?.count, 1, "only the answered try is timed");
  } finally {
    await chat.close();
  }
});

test("a day file older than yesterday goes when the day changes", async () => {
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  for (const day of ["2026-10-31", "2026-11-01", "2026-11-02"]) writeFileSync(join(dir, `${day}.jsonl`), "");
  const log = new RequestLog(dir);
  log.write({ at: Date.UTC(2026, 10, 3, 1), src: "server", m: "GET", r: "/api/me", p: "/api/me", s: 200, ms: 1 });
  await log.flushed();
  assert.deepEqual(readdirSync(dir).sort(), ["2026-11-01.jsonl", "2026-11-02.jsonl", "2026-11-03.jsonl"]);
});

test("the precheck reads each metric from the client's lines, falls back to the server's, and names the 3 slowest routes", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  const now = Date.UTC(2026, 10, 3, 9);
  const at = now - 3600_000;
  const row = (src: string, m: string, r: string, ms: number, when = at, net?: number) =>
    JSON.stringify({ at: when, src, m, r, p: r.replace(":id", "dm_x").replace(":root", "p1"), s: 200, ms, ...(net === undefined ? {} : { net }) });
  const rows = [
    ...[100, 120, 130, 140, 150, 160, 170, 180, 190, 2000].map(ms => row("client", "GET", "/api/c/:id/items", ms)),
    row("client", "GET", "/api/c/:id/replies/:root", 10, at, 8),
    row("client", "GET", "/api/c/:id/replies/:root", 2500, at, 30),
    row("client", "GET", "/api/search", 900),
    row("server", "GET", "/api/search", 5),
    row("server", "POST", "/api/c/:id/send", 40),
    row("client", "GET", "/api/me", 3),
    row("client", "GET", "/api/search", 99_000, now - 30 * 3600_000),
  ];
  writeFileSync(join(dir, "requests", "2026-11-02.jsonl"), `${rows.at(-1)}\n`);
  writeFileSync(join(dir, "requests", "2026-11-03.jsonl"), `${rows.slice(0, -1).join("\n")}\n{"torn`);
  const out = apiSpeed(dir, now, 24 * 3600_000);
  assert.deepEqual(out.metrics, {
    slowest_api_p90_ms: 2500, search_p90_ms: 900, thread_open_p90_ms_messages: 190, thread_open_p90_ms_replies: 2500, thread_open_p90_ms: 2500, send_p90_ms: 40,
    failed_sends_24h: 0,
  });
  assert.equal(out.metricSources.send, "server, 1 requests");
  assert.deepEqual(out.slowest.map(s => s.route), ["GET /api/c/:id/replies/:root", "GET /api/search", "GET /api/c/:id/items"]);
  assert.equal(out.flagged.length, 3);
  assert.equal(out.flagged[0]!.excerpt, "GET /api/c/:id/replies/:root p90 2500 ms, p50 10 ms, max 2500 ms over 2 requests from browsers on the box, such as job walks, or pages from before the server named where a page ran; on the 2 lines that carry the network time, the network and the server took p90 30 ms, p50 8 ms, so the page's main thread held the rest in long tasks; trace a page load in the box Chrome to find them; the slowest was /api/c/dm_x/replies/p1");
  assert.match(out.flagged[1]!.excerpt, /no line carries the network time yet/);
});

test("the precheck reads the owner's devices first, then any page, then the server", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  const now = Date.UTC(2026, 10, 3, 9);
  const row = (src: string, ms: number, via?: string) => JSON.stringify({ at: now - 60_000, src, m: "GET", r: "/api/c/:id/items", p: "/api/c/dm_x/items", s: 200, ms, ...(via ? { via } : {}) });
  writeFileSync(join(dir, "requests", "2026-11-03.jsonl"), `${[row("client", 2000, "local"), row("client", 1500), row("client", 80, "tailnet"), row("server", 5)].join("\n")}\n`);
  const out = apiSpeed(dir, now, 24 * 3600_000);
  assert.equal(out.metrics.thread_open_p90_ms_messages, 80);
  assert.equal(out.metrics.slowest_api_p90_ms, 80);
  assert.equal(out.metricSources.messages, "tailnet, 1 requests");
  assert.deepEqual(out.routes.map(s => [s.src, s.count, s.p90]), [["client", 2, 2000], ["tailnet", 1, 80], ["server", 1, 5]]);
});

test("a finding whose wait is close to its network time blames the network or the server", () => {
  const excerpt = finding({ route: "GET /api/usage", src: "tailnet", count: 4, p50: 300, p90: 390, max: 400, slowestPath: "/api/usage", netCount: 4, netP50: 290, netP90: 380 });
  assert.match(excerpt, /^GET \/api\/usage p90 390 ms.*from the owner's devices; on the 4 lines .* p90 380 ms, p50 290 ms, so the network or the server held the wait;/);
});
