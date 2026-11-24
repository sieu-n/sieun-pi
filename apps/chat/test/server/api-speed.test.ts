/**
 * The request log and the speed duty's precheck: the server writes one line per /api request with its route pattern, POST /api/timings
 * takes the web client's waits, an old day file goes, and `scripts/duties/api-speed.ts` reads each metric from the owner's tailnet lines with the
 * server's handler time plus his network p50 as the fallback.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { agedOut, agingSince, overdueWindow, pushMisses } from "../../../../legacy/prime/user-history/src/duty-push.ts";
import { metricStreaks } from "../../../../legacy/prime/user-history/src/shared/duty-streak.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import { apiSpeed, finding, LOOKBACK_MS, MIN_NETWORK_LINES, MIN_OWN_CALLS, ownBefore, probeRoutes, probeSpeed, readTimings, routeSpeeds, unmeasured } from "../../scripts/duties/api-speed.ts";
import { parseStarts } from "../../scripts/restart-walk-hits.ts";
import { dayOf, LoopStalls, RequestLog, type RequestTiming } from "../../server/request-log.ts";
import { StallProfiler } from "../../../../packages/pi-host/src/stall-profile.ts";
import { start, until } from "./helpers.ts";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "apps-chat-api-speed-"));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));

const lines = (dir: string): RequestTiming[] =>
  existsSync(join(dir, "requests"))
    ? readdirSync(join(dir, "requests")).flatMap(name => readFileSync(join(dir, "requests", name), "utf8").split("\n").slice(0, -1).map(line => JSON.parse(line) as RequestTiming))
    : [];

/**
 * The server appends a line on its request log's own queue after it answers, so a test reads the log once the lines it expects are there.
 * In a full parallel server run at a box load of about 150 on 11-23, three client lines were not yet written 50 ms after their POST.
 */
const logged = (dir: string, ready: (logged: RequestTiming[]) => boolean): Promise<RequestTiming[]> => until(async () => lines(dir), ready);
const clientLines = (count: number) => (logged: RequestTiming[]) => logged.filter(line => line.src === "client").length >= count;

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
      { m: "POST", p: `/api/c/${room}%3A12/workspace/close`, s: 200, ms: 40 },
    ] });
    assert.deepEqual(posted, { status: 200, body: { taken: 3 } });
    const viaTailnet = await fetch(`${chat.base}/api/timings`, {
      method: "POST", headers: { "content-type": "application/json", "tailscale-user-login": "owner@example.com" },
      body: JSON.stringify({ samples: [{ m: "GET", p: "/api/rooms", s: 200, ms: 30, net: 4 }] }),
    });
    assert.equal(viaTailnet.status, 200);
    // A job's box Chrome on the tailnet URL carries his login too, with one of the box's own addresses as the caller (p278).
    const own = Object.values(networkInterfaces()).flatMap(list => list ?? []).find(one => !one.internal)?.address ?? "127.0.0.1";
    const fromBox = await fetch(`${chat.base}/api/timings`, {
      method: "POST", headers: { "content-type": "application/json", "tailscale-user-login": "owner@example.com", "x-forwarded-for": own },
      body: JSON.stringify({ samples: [{ m: "GET", p: "/api/me", s: 200, ms: 38, net: 9 }] }),
    });
    assert.equal(fromBox.status, 200);
    const browser = await fetch(`${chat.base}/api/me`, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/131.0" } });
    assert.equal(browser.status, 200);
    const all = await logged(dataDir, got => clientLines(5)(got) && got.some(line => line.src === "server" && line.r === "/api/c/:id/items") && got.some(line => line.src === "server" && line.p === "/api/me"));
    assert.equal(all.find(line => line.src === "server" && line.p === "/api/me")?.ua, undefined, "a browser's call carries no ua");
    const server = all.find(line => line.src === "server" && line.p === `/api/c/${room}/items`);
    assert.equal(server?.r, "/api/c/:id/items");
    assert.equal(server?.s, 200);
    assert.ok(server!.ms >= 0);
    assert.equal(server?.ua, "node", "a script's call names its User-Agent");
    assert.ok(!all.some(line => line.p === "/api/timings"), "the timings post itself is not logged");
    const client = all.filter(line => line.src === "client");
    assert.deepEqual(client.map(line => [line.r, line.p, line.ms, line.net, line.via]), [
      ["/api/c/:id/items", `/api/c/${room}/items`, 420, 12, "local"], ["/api/search", "/api/search", 90, undefined, "local"],
      ["/api/c/:id/workspace/close", `/api/c/${room}%3A12/workspace/close`, 40, undefined, "local"], ["/api/rooms", "/api/rooms", 30, 4, "tailnet"],
      ["/api/me", "/api/me", 38, 9, "local"],
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
    const isRead = (line: RequestTiming) => line.src === "server" && line.r === "/api/c/:id/read";
    const read = (await logged(dataDir, got => got.some(isRead))).find(isRead);
    assert.ok(read?.body !== undefined && read.run !== undefined && read.body + read.run <= read.ms + 0.2, JSON.stringify(read));
  } finally {
    await chat.close();
  }
});

test("a stall names the loop thread's CPU in it and the function that held the loop", async () => {
  const stalls = new LoopStalls(new StallProfiler({ intervalUs: 5_000 }));
  try {
    await new Promise(resolve => setTimeout(resolve, 60));
    const since = performance.now();
    function holdTheLoopForSearch(): void {
      const blocked = performance.now();
      while (performance.now() - blocked < 200) { /* holds the loop */ }
    }
    holdTheLoopForSearch();
    await new Promise(resolve => setTimeout(resolve, 60));
    const worst = stalls.worst(since);
    assert.ok(worst.stall >= 150, JSON.stringify(worst));
    assert.ok((worst.stallCpu ?? 0) >= 120, `a loop held on CPU reads as CPU time: ${JSON.stringify(worst)}`);
    assert.match(worst.stallBy ?? "", /holdTheLoopForSearch/);
  } finally {
    stalls.stop();
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
    await logged(dataDir, got => got.filter(line => line.r === "/api/c/:id/send").length >= 6);
    assert.ok(logs.some(line => line.startsWith(`POST /api/c/:id/send ${p} 400: No upload blob:x;`)), logs.join("\n"));
    assert.ok(logs.includes(`POST /api/c/:id/send ${p} 400: A message needs text, an image or a forwarded post.`), logs.join("\n"));
    assert.ok(logs.includes(`client POST /api/c/:id/send ${p} unreached (local): TypeError: Failed to fetch`), logs.join("\n"));
    assert.ok(logs.includes(`client POST /api/c/:id/send ${p} Not delivered (local): TypeError: Failed to fetch`), logs.join("\n"));
    const sends = lines(dataDir).filter(line => line.r === "/api/c/:id/send");
    assert.deepEqual(sends.map(line => [line.src, line.s, line.err?.slice(0, 15), line.shown]), [
      ["server", 400, "No upload blob:", undefined], ["server", 400, "A message needs", undefined], ["client", 0, "TypeError: Fail", undefined],
      ["client", 400, "No upload blob:", undefined], ["client", 400, "No upload blob:", true], ["client", 0, "TypeError: Fail", true],
    ]);
    // The two refusals and the send that never reached the server failed; the unreached try and the page's copies of the refusal did not.
    // All three came from this box, as a job's walk does, so they are flagged apart and the owner's count stays 0.
    const out = apiSpeed(dataDir, Date.now() + 1, 3600_000);
    assert.equal(out.metrics.failed_sends_24h, 0);
    assert.equal(out.flagged.filter(row => row.kind === "failed_send").length, 0);
    const walks = out.flagged.filter(row => row.kind === "walk_failed_send");
    assert.deepEqual(walks.map(row => row.sig), ["server via local:POST /api/c/:id/send:400", "server via local:POST /api/c/:id/send:400", "client via local:POST /api/c/:id/send:0"]);
    assert.match(walks[2]!.excerpt, /never reached the server \(client via local, Not delivered after the page's tries\): TypeError: Failed to fetch$/);
    assert.equal(out.routes.find(route => route.src === "client" && route.route === "POST /api/c/:id/send")?.count, 1, "only the answered try is timed");
  } finally {
    await chat.close();
  }
});

test("failed_sends_24h counts the owner's failed sends and flags a box walk's apart", async () => {
  const dataDir = tempDir();
  const chat = await start({ dataDir });
  try {
    const channel = (await chat.get("/api/sidebar")).channels[0].id as string;
    const send = (tailnet: boolean) => fetch(`${chat.base}/api/c/${channel}/send`, {
      method: "POST", headers: { "content-type": "application/json", ...(tailnet ? { "tailscale-user-login": "owner@example.com" } : {}) },
      body: JSON.stringify({ text: " ", requestId: `r-${tailnet}` }),
    });
    assert.deepEqual([(await send(true)).status, (await send(false)).status], [400, 400]);
    assert.deepEqual((await logged(dataDir, got => got.filter(line => line.r === "/api/c/:id/send").length >= 2)).filter(line => line.r === "/api/c/:id/send").map(line => [line.src, line.s, line.via]), [["server", 400, "tailnet"], ["server", 400, "local"]]);
    const p = `/api/c/${channel}/send`;
    const old = { at: Date.now() - 1000, src: "server", m: "POST", r: "/api/c/:id/send", p, s: 400, ms: 3, err: "No upload blob:x" };
    const shown = (via: string) => ({ at: Date.now() - 1000, src: "client", m: "POST", r: "/api/c/:id/send", p, s: 0, ms: 0, err: "TypeError: Failed to fetch", shown: true, via });
    writeFileSync(join(dataDir, "requests", `${dayOf(Date.now())}.jsonl`), [old, shown("tailnet"), shown("local")].map(line => `${JSON.stringify(line)}\n`).join(""), { flag: "a" });
    const out = apiSpeed(dataDir, Date.now() + 1, 3600_000);
    // The tailnet refusal, the old refusal with no via and the tailnet page's Not delivered count; the local refusal and local page do not.
    assert.equal(out.metrics.failed_sends_24h, 3);
    assert.deepEqual(out.flagged.filter(row => row.kind.endsWith("failed_send")).map(row => `${row.kind} ${row.sig}`), [
      "failed_send server via tailnet:POST /api/c/:id/send:400", "failed_send server:POST /api/c/:id/send:400", "failed_send client via tailnet:POST /api/c/:id/send:0",
      "walk_failed_send server via local:POST /api/c/:id/send:400", "walk_failed_send client via local:POST /api/c/:id/send:0",
    ]);
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

test("the precheck reads each metric from the owner's lines, falls back to the server's plus his network, and flags walks apart", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  const now = Date.UTC(2026, 10, 3, 9);
  const at = now - 3600_000;
  const row = (src: string, via: string | undefined, m: string, r: string, ms: number, when = at, net?: number) =>
    JSON.stringify({ at: when, src, m, r, p: r.replace(":id", "dm_x").replace(":root", "p1"), s: 200, ms, ...(via ? { via } : {}), ...(net === undefined ? {} : { net }) });
  const rows = [
    ...[100, 120, 130, 140, 150, 160, 170, 180, 190, 2000].map(ms => row("client", "tailnet", "GET", "/api/c/:id/items", ms, at, 20)),
    row("client", "tailnet", "GET", "/api/c/:id/replies/:root", 10, at, 8),
    row("client", "tailnet", "GET", "/api/c/:id/replies/:root", 2500, at, 30),
    row("client", "local", "GET", "/api/search", 900),
    row("server", undefined, "GET", "/api/search", 5),
    row("client", "local", "POST", "/api/c/:id/send", 288),
    row("server", "local", "POST", "/api/c/:id/send", 40),
    row("client", "local", "GET", "/api/me", 3),
    ...Array.from({ length: 18 }, () => row("client", "tailnet", "GET", "/api/rooms", 20, at, 20)),
    row("client", "tailnet", "GET", "/api/search", 99_000, now - 80 * 3600_000),
  ];
  writeFileSync(join(dir, "requests", "2026-10-30.jsonl"), `${rows.at(-1)}\n`);
  writeFileSync(join(dir, "requests", "2026-11-03.jsonl"), `${rows.slice(0, -1).join("\n")}\n{"torn`);
  const out = apiSpeed(dir, now, 24 * 3600_000);
  // The network p50 is 20 ms over the owner's 30 lines, so search reads 5 + 20 and send 40 + 20; the walks' 900 and 288 set nothing.
  assert.deepEqual(out.metrics, {
    slowest_api_p90_ms: 2500, search_p90_ms: 25, thread_open_p90_ms_messages: 190, thread_open_p90_ms_replies: 2500, thread_open_p90_ms: 2500, send_p90_ms: 60,
    failed_sends_24h: 0,
  });
  assert.equal(out.metricSources.messages, "GET /api/c/:id/items: the owner's devices, 10 requests");
  assert.equal(out.metricSources.send, "POST /api/c/:id/send: an estimate, since the owner made no request of this route in the request log's last 72 h: the server's handler p90 40 ms over 1 requests plus his network p50 20 ms over 30 tailnet requests");
  assert.deepEqual(out.slowest.map(s => s.route), ["GET /api/c/:id/replies/:root", "GET /api/c/:id/items", "POST /api/c/:id/send"]);
  assert.deepEqual(out.flagged.map(row => `${row.kind} ${row.sig}`), [
    "slow_api tailnet:GET /api/c/:id/replies/:root", "slow_api tailnet:GET /api/c/:id/items", "slow_api server:POST /api/c/:id/send",
    "slow_call slow_call:GET /api/c/:id/items", "walk_slow_api client:GET /api/search", "walk_slow_api client:POST /api/c/:id/send", "walk_slow_api client:GET /api/me",
  ]);
  assert.equal(out.flagged[0]!.excerpt, "GET /api/c/:id/replies/:root p90 2500 ms, p50 10 ms, max 2500 ms over 2 requests from the owner's devices; on the 2 lines that carry the network time, the network and the server took p90 30 ms, p50 8 ms, so the page's main thread held the rest in long tasks; trace a page load in the box Chrome to find them; the slowest was /api/c/dm_x/replies/p1");
  assert.match(out.flagged[2]!.excerpt, /^POST \/api\/c\/:id\/send p90 about 60 ms for the owner: an estimate, since the owner made no request/);
  assert.equal(out.flagged[3]!.excerpt, "2026-11-03T08:00:00.000Z GET /api/c/dm_x/items waited 2000 ms on the owner's page, 20 ms of it on the network, above the p90 of 190 ms its route reads");
  assert.match(out.flagged[4]!.excerpt, /from browsers on the box, such as job walks.*no line carries the network time yet/);
});

test("a read ahead of any view counts in no speed, and a refresh behind a page the screen already showed counts as a 0 ms wait", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  const now = Date.UTC(2026, 10, 20, 9);
  const row = (r: string, ms: number, bg?: string) =>
    JSON.stringify({ at: now - 3600_000, src: "client", via: "tailnet", m: "GET", r, p: r.replace(":id", "dm_x").replace(":root", "p1"), s: 200, ms, net: ms, ...(bg ? { bg } : {}) });
  writeFileSync(join(dir, "requests", "2026-11-20.jsonl"), `${[
    row("/api/c/:id/items", 410, "ahead"), row("/api/c/:id/items", 405, "ahead"),
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map(() => row("/api/c/:id/items", 205, "shown")), row("/api/c/:id/items", 230),
    row("/api/c/:id/replies/:root", 648), row("/api/c/:id/replies/:root", 210, "shown"),
  ].join("\n")}\n`);
  const out = apiSpeed(dir, now, 24 * 3600_000);
  assert.equal(out.metrics.thread_open_p90_ms_messages, 0);
  assert.equal(out.metrics.thread_open_p90_ms_replies, 648);
  assert.equal(out.metrics.thread_open_p90_ms, 648);
  assert.equal(out.metricSources.messages, "GET /api/c/:id/items: the owner's devices, 10 requests, 9 of them behind a page the screen already showed (0 ms)");
  const items = out.routes.find(s => s.route === "GET /api/c/:id/items")!;
  assert.deepEqual([items.count, items.shown, items.max, items.netP50], [10, 9, 230, 205]);

  const dataDir = tempDir();
  const chat = await start({ dataDir });
  try {
    await chat.send("POST", "/api/timings", { samples: [
      { m: "GET", p: "/api/rooms", s: 200, ms: 200, bg: "ahead" }, { m: "GET", p: "/api/rooms", s: 200, ms: 201, bg: "shown" }, { m: "GET", p: "/api/rooms", s: 200, ms: 202, bg: true },
    ] });
    assert.deepEqual((await logged(dataDir, clientLines(3))).filter(line => line.src === "client").map(line => [line.ms, line.bg]), [[200, "ahead"], [201, "shown"], [202, undefined]]);
  } finally {
    await chat.close();
  }
});

test("an upload's client line keeps the ms its image encode took, and an image send's the ms until it was stored", async () => {
  const dataDir = tempDir();
  const chat = await start({ dataDir });
  try {
    await chat.send("POST", "/api/timings", { samples: [
      { m: "POST", p: "/api/uploads", s: 200, ms: 800, enc: 412, bg: "shown" }, { m: "POST", p: "/api/uploads", s: 200, ms: 801, enc: "slow" },
      { m: "POST", p: "/api/c/dm_x/send", s: 200, ms: 12, stored: 1900 },
    ] });
    assert.deepEqual((await logged(dataDir, clientLines(3))).filter(line => line.src === "client").map(line => [line.ms, line.enc, line.stored, line.bg]),
      [[800, 412, undefined, "shown"], [801, undefined, undefined, undefined], [12, undefined, 1900, undefined]]);
  } finally {
    await chat.close();
  }
});

test("a walk never sets a metric, and with no tailnet line the server's handler time stands alone", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  const now = Date.UTC(2026, 10, 3, 9);
  const row = (src: string, ms: number, via?: string, net?: number) =>
    JSON.stringify({ at: now - 60_000, src, m: "GET", r: "/api/c/:id/items", p: "/api/c/dm_x/items", s: 200, ms, ...(via ? { via } : {}), ...(net === undefined ? {} : { net }) });
  const file = join(dir, "requests", "2026-11-03.jsonl");
  writeFileSync(file, `${[row("client", 2000, "local"), row("client", 1500), row("server", 5)].join("\n")}\n`);
  const alone = apiSpeed(dir, now, 24 * 3600_000);
  assert.equal(alone.metrics.thread_open_p90_ms_messages, 5);
  assert.equal(alone.metrics.slowest_api_p90_ms, 5);
  assert.equal(alone.network, undefined);
  assert.match(alone.metricSources.messages!, /handler p90 5 ms over 1 requests alone, since no tailnet request in the window carries the network time$/);
  writeFileSync(file, `${row("client", 80, "tailnet", 60)}\n`, { flag: "a" });
  const own = apiSpeed(dir, now, 24 * 3600_000);
  assert.equal(own.metrics.thread_open_p90_ms_messages, 80);
  assert.equal(own.metricSources.messages, "GET /api/c/:id/items: the owner's devices, 1 requests");
  assert.deepEqual(own.routes.map(s => [s.src, s.count, s.p90]), [["client", 2, 2000], ["tailnet", 1, 80], ["server", 1, 5]]);
});

test("a network time from too few of the owner's lines sets no metric, and the source says so", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  const now = Date.UTC(2026, 10, 23, 6);
  const row = (src: string, r: string, ms: number, via?: string, net?: number) =>
    JSON.stringify({ at: now - 60_000, src, m: "GET", r, p: r.replace(":id", "dm_x"), s: 200, ms, ...(via ? { via } : {}), ...(net === undefined ? {} : { net }) });
  const file = join(dir, "requests", "2026-11-23.jsonl");
  const wake = (count: number) => Array.from({ length: count }, () => row("client", "/api/search/recent", 800, "tailnet", 793));
  writeFileSync(file, `${[row("server", "/api/search", 105), row("server", "/api/c/:id/items", 22), ...wake(1)].join("\n")}\n`);
  const one = apiSpeed(dir, now, 15 * 3600_000);
  assert.deepEqual(one.network, { count: 1, p50: 793 });
  assert.equal(one.metrics.search_p90_ms, 105, "one waking call's 793 ms adds to no handler time");
  assert.equal(one.metrics.thread_open_p90_ms, 22);
  assert.equal(one.metricSources.search, "GET /api/search: an estimate, since the owner made no request of this route in the request log's last 72 h: the server's handler p90 105 ms over 1 requests alone, since only 1 tailnet requests in the window carry the network time (p50 793 ms) and fewer than 30 set no metric");
  const probe = { route: "GET /api/search", at: now, path: "/api/search?q=duty", ms: [40, 50] };
  assert.equal(probeSpeed(probe, one.network)!.p90, 50, "a probe stands alone the same way");
  assert.match(probeSpeed(probe, one.network)!.source, /took p90 50 ms alone, since only 1 tailnet requests .* fewer than 30 set no metric$/);
  writeFileSync(file, `${wake(MIN_NETWORK_LINES - 2).join("\n")}\n`, { flag: "a" });
  assert.equal(apiSpeed(dir, now, 15 * 3600_000).metrics.search_p90_ms, 105, "29 lines are still too few");
  writeFileSync(file, `${wake(1).join("\n")}\n`, { flag: "a" });
  const enough = apiSpeed(dir, now, 15 * 3600_000);
  assert.equal(enough.metrics.search_p90_ms, 898);
  assert.match(enough.metricSources.search!, /plus his network p50 793 ms over 30 tailnet requests$/);
});

test("a finding whose wait is close to its network time blames the network or the server", () => {
  const excerpt = finding({ route: "GET /api/usage", src: "tailnet", count: 4, p50: 300, p90: 390, max: 400, slowestPath: "/api/usage", netCount: 4, netP50: 290, netP90: 380 });
  assert.match(excerpt, /^GET \/api\/usage p90 390 ms.*from the owner's devices; on the 4 lines .* p90 380 ms, p50 290 ms, so the network or the server held the wait;/);
});

test("with no line of the owner's or the server's on a metric route, the CLI's probe of the live server sets it, and a failed probe flags why", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  const now = Date.now();
  const row = (via: string, r: string, p: string, ms: number, net?: number) =>
    JSON.stringify({ at: now - 60_000, src: "client", m: "GET", r, p, s: 200, ms, via, ...(net === undefined ? {} : { net }) });
  writeFileSync(join(dir, "requests", `${dayOf(now)}.jsonl`), `${[
    row("local", "/api/c/:id/items", "/api/c/dm_busy/items", 900), row("local", "/api/c/:id/items", "/api/c/dm_busy/items", 800),
    row("local", "/api/search", "/api/search", 700), ...Array.from({ length: MIN_NETWORK_LINES }, () => row("tailnet", "/api/rooms", "/api/rooms", 30, 12)),
  ].join("\n")}\n`);
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url!);
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/api/rooms") return json(200, [{ id: "ch_room" }]);
    if (req.url === "/api/c/dm_busy/items") return json(200, { items: [{ kind: "message", id: "p1" }] });
    if (req.url === "/api/c/ch_room/items") return json(200, { items: [{ kind: "message", id: "p1" }, { kind: "message", id: "p2", thread: { replies: 3 } }] });
    if (req.url === "/api/c/ch_room/replies/p2") return json(200, { root: {}, items: [] });
    return json(500, { error: "search index is closed" });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const timings = readTimings(dir, now, 3600_000);
    const missing = unmeasured(routeSpeeds(timings));
    assert.deepEqual(missing, ["GET /api/search", "GET /api/c/:id/items", "GET /api/c/:id/replies/:root"], "a box walk's line leaves its route unmeasured");
    const probes = await probeRoutes(base, missing, timings);
    assert.deepEqual(probes.map(p => [p.route, p.path, "ms" in p ? p.ms.length : p.error]), [
      ["GET /api/search", "/api/search?q=duty", 'GET /api/search?q=duty answered 500: {"error":"search index is closed"}'],
      ["GET /api/c/:id/items", "/api/c/dm_busy/items", 5],
      ["GET /api/c/:id/replies/:root", "/api/c/ch_room/replies/p2", 5],
    ]);
    assert.equal(seen.filter(url => url === "/api/c/dm_busy/items").length, 1 + 5 + 1, "the busiest thread in the log is the one probed");
    const out = apiSpeed(dir, now, 3600_000, probes);
    const p90 = (route: string) => { const p = probes.find(probe => probe.route === route)!; return "ms" in p ? [...p.ms].sort((a, b) => a - b).at(-1)! : NaN; };
    assert.equal(out.metrics.search_p90_ms, undefined, "a failed probe gives no value");
    assert.equal(out.metrics.thread_open_p90_ms_messages, Math.round((p90("GET /api/c/:id/items") + 12) * 10) / 10, "the probe's p90 plus the owner's network p50");
    assert.equal(out.metrics.thread_open_p90_ms_replies, Math.round((p90("GET /api/c/:id/replies/:root") + 12) * 10) / 10);
    assert.ok(out.metrics.slowest_api_p90_ms! >= out.metrics.thread_open_p90_ms!);
    assert.match(out.metricSources.messages!, /^GET \/api\/c\/:id\/items: a probe from the box at \d{4}-\d\d-\d\dT[\d:.]+Z, since the owner made no call in the window: 5 GETs of \/api\/c\/dm_busy\/items took p90 [\d.]+ ms plus his network p50 12 ms over 30 tailnet requests$/);
    assert.deepEqual(out.flagged.filter(f => f.kind === "probe_failed").map(f => f.sig), ["probe:GET /api/search"]);
    assert.match(out.flagged.find(f => f.kind === "probe_failed")!.excerpt, /^GET \/api\/search has no value: a probe from the box at .* failed: GET \/api\/search\?q=duty answered 500/);
    assert.deepEqual(await probeRoutes(base, [], timings), [], "a measured window probes nothing");
  } finally {
    await new Promise(done => server.close(done));
  }
});

test("failed_sends_24h counts the owner's calls a restart or hand-over failed that he could see or lose, each once, as restart_hit rows", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  const now = Date.UTC(2026, 10, 22, 12);
  const reload = now - 3600_000;
  const journal = [
    `${(reload - 30_000) / 1000}.000000 us-metal02 systemd[8987]: Started sieun-pi-apps-chat.service - apps/chat.`,
    `${reload / 1000}.000000 us-metal02 systemd[8987]: Reloading sieun-pi-apps-chat.service - apps/chat...`,
    `${reload / 1000 + 0.01}.000000 us-metal02 systemd[8987]: Reloaded sieun-pi-apps-chat.service - apps/chat.`,
  ].join("\n");
  const restarts = parseStarts(journal);
  assert.deepEqual(restarts, [reload - 30_000, reload]);
  const row = (after: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ at: reload + after, src: "client", via: "tailnet", m: "GET", r: "/api/later", p: "/api/later", s: 0, ms: 47, err: "TypeError: Load failed", page: "visible", ...extra });
  writeFileSync(join(dir, "requests", "2026-11-22.jsonl"), `${[
    row(5_000),
    row(60_000),
    row(5_000, { via: "local" }),
    row(5_000, { page: "leaving" }),
    row(5_000, { page: "hidden" }),
    row(5_000, { bg: "ahead" }),
    row(5_000, { page: undefined }),
    row(5_000, { page: undefined, r: "/api/rooms", p: "/api/rooms", s: 502, err: "GET /api/rooms failed with 502" }),
    row(5_000, { s: 400, err: "No post p35 in #mcp-dev." }),
    row(5_000, { m: "PATCH", r: "/api/c/:id", p: "/api/c/dm_x", page: "hidden" }),
    row(6_000, { m: "POST", r: "/api/c/:id/send", p: "/api/c/dm_x/send", shown: true }),
    row(7_000, { s: 200, err: undefined }),
  ].join("\n")}\n`);
  const out = apiSpeed(dir, now, 24 * 3600_000, [], restarts);
  // Count: the visible page's GET that failed after its tries, the older line's 502, the PATCH that never landed and the Not delivered
  // send (once). Leave out: the GET 60 s after, a box browser's line, an abort by the page's own reload, a hidden page's read, a read
  // ahead, an older line's network error, a 4xx and a call that landed.
  assert.equal(out.metrics.failed_sends_24h, 4);
  const hits = out.flagged.filter(row => row.kind === "restart_hit");
  assert.deepEqual(hits.map(row => row.sig), ["restart:GET /api/later:0", "restart:GET /api/rooms:502", "restart:PATCH /api/c/:id:0"]);
  assert.equal(hits[0]!.excerpt, `${new Date(reload + 5_000).toISOString()} GET /api/later never reached the server on the owner's page, logged 5 s after the apps/chat restart or hand-over at ${new Date(reload).toISOString()}: TypeError: Load failed`);
  assert.deepEqual(out.flagged.filter(row => row.kind === "failed_send").map(row => row.sig), ["client via tailnet:POST /api/c/:id/send:0"]);
  assert.equal(apiSpeed(dir, now, 24 * 3600_000).metrics.failed_sends_24h, 1);
});

test("the server keeps what a failed call's page was doing, and drops a value it does not know", async () => {
  const dataDir = tempDir();
  const chat = await start({ dataDir });
  try {
    await chat.send("POST", "/api/timings", { samples: [
      { m: "GET", p: "/api/later", s: 0, ms: 40, err: "TypeError: Load failed", page: "leaving" },
      { m: "GET", p: "/api/later", s: 0, ms: 41, err: "TypeError: Load failed", page: "visible" },
      { m: "GET", p: "/api/later", s: 0, ms: 42, err: "TypeError: Load failed", page: "gone" },
    ] });
    assert.deepEqual((await logged(dataDir, clientLines(3))).filter(line => line.src === "client").map(line => [line.ms, line.page]), [[40, "leaving"], [41, "visible"], [42, undefined]]);
  } finally {
    await chat.close();
  }
});

test("the ms a page was hidden count in no wait, and an old line without them counts whole", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  const now = Date.UTC(2026, 10, 22, 14, 41);
  const at = Date.UTC(2026, 10, 22, 13, 50, 24);
  const row = (r: string, ms: number, net: number, more: Record<string, unknown> = {}) =>
    JSON.stringify({ at, src: "client", via: "tailnet", m: "GET", r, p: r.replace(":id", "ag_agent-factory"), s: 200, ms, net, ...more });
  // The owner's batch of 11-22 13:50:24 after his Mac woke (requests/2026-11-22.jsonl), whose board refresh changed the panel 20,866 ms
  // after the page asked for it; no line of that page says whether it was hidden, so the duty reads the wait whole.
  const batch = [
    row("/api/later", 4067, 4008), row("/api/owner-settings", 4058, 3971), row("/api/agents/:id/duties", 20682, 219), row("/api/agents/:id/board", 20866, 421),
    row("/api/rooms", 20724, 206, { bg: "shown" }), row("/api/later", 11400, 419, { bg: "shown" }),
  ];
  writeFileSync(join(dir, "requests", "2026-11-22.jsonl"), `${batch.join("\n")}\n`);
  assert.equal(apiSpeed(dir, now, 24 * 3600_000).metrics.slowest_api_p90_ms, 20866);
  // The same reads from a page that was hidden for 20,000 ms of their wait count the 866 and 682 ms he could see.
  writeFileSync(join(dir, "requests", "2026-11-22.jsonl"), `${[
    row("/api/later", 4067, 4008), row("/api/owner-settings", 4058, 3971), row("/api/agents/:id/duties", 20682, 219, { hid: 20000 }), row("/api/agents/:id/board", 20866, 421, { hid: 20000 }),
  ].join("\n")}\n`);
  const out = apiSpeed(dir, now, 24 * 3600_000);
  assert.equal(out.metrics.slowest_api_p90_ms, 4067);
  assert.deepEqual(["GET /api/agents/:id/board", "GET /api/agents/:id/duties"].map(route => out.routes.find(s => s.route === route)?.p90), [866, 682]);

  const dataDir = tempDir();
  const chat = await start({ dataDir });
  try {
    await chat.send("POST", "/api/timings", { samples: [
      { m: "GET", p: "/api/rooms", s: 200, ms: 900, hid: 700 }, { m: "GET", p: "/api/rooms", s: 200, ms: 901, hid: 5000 },
      { m: "GET", p: "/api/rooms", s: 200, ms: 902, hid: "long" }, { m: "GET", p: "/api/rooms", s: 200, ms: 903, hid: -1 },
    ] });
    assert.deepEqual((await logged(dataDir, clientLines(4))).filter(line => line.src === "client").map(line => [line.ms, line.hid]), [[900, 700], [901, 901], [902, undefined], [903, undefined]]);
  } finally {
    await chat.close();
  }
});

test("a route the owner used little in the window reads over his newest 10 requests on it, his window's among them", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  // 11-24 06:30 KST, the first run after a day he used the page little (requests/2026-11-22.jsonl and 2026-11-23.jsonl).
  const now = Date.UTC(2026, 10, 23, 21, 30);
  const hours = (h: number) => now - h * 3600_000;
  const row = (r: string, ms: number, at: number, more: Record<string, unknown> = {}) =>
    JSON.stringify({ at, src: "client", via: "tailnet", m: "GET", r, p: r.replace(":id", "dm_x").replace(":root", "p1"), s: 200, ms, net: Math.min(ms, 212), ...more });
  const shown = (r: string, at: number) => row(r, 230, at, { bg: "shown" });
  const older = [
    row("/api/c/:id/items", 900, hours(60)), row("/api/c/:id/items", 230, hours(40)), row("/api/c/:id/items", 240, hours(39)),
    ...[38, 37, 36, 35, 34].map(h => shown("/api/c/:id/items", hours(h))),
    row("/api/c/:id/replies/:root", 300, hours(40)), shown("/api/c/:id/replies/:root", hours(39)), shown("/api/c/:id/replies/:root", hours(38)), row("/api/c/:id/replies/:root", 350, hours(37)),
    row("/api/search", 5000, hours(30)),
    ...[32, 31, 30, 29, 28, 27, 26, 25].map(h => row("/api/agents/:id/board", 0, hours(h), { bg: "shown" })),
    row("/api/later", 4067, hours(30)), row("/api/later", 4067, hours(29)), row("/api/later", 4067, hours(28)),
    row("/api/c/:id/items", 800, hours(30), { via: "local" }),
    row("/api/c/:id/items", 800, hours(30), { bg: "ahead" }),
  ];
  const window = [
    shown("/api/c/:id/items", hours(5)), shown("/api/c/:id/items", hours(4)), row("/api/c/:id/items", 270, hours(3)),
    JSON.stringify({ at: hours(3), src: "server", m: "GET", r: "/api/c/:id/replies/:root", p: "/api/c/dm_x/replies/p1", s: 200, ms: 2 }),
    ...[100, 101, 102, 103, 104, 105, 106, 107, 108, 109].map(ms => row("/api/search", ms, hours(2))),
    row("/api/agents/:id/board", 1500, hours(2)), row("/api/agents/:id/board", 1200, hours(1)),
    JSON.stringify({ at: hours(2), src: "server", m: "POST", r: "/api/c/:id/send", p: "/api/c/dm_x/send", s: 200, ms: 40 }),
  ];
  const day = (line: string) => new Date((JSON.parse(line) as { at: number }).at).toISOString().slice(0, 10);
  for (const name of ["2026-11-21", "2026-11-22", "2026-11-23"]) {
    const rows = [...older, ...window].filter(line => day(line) === name);
    if (rows.length) writeFileSync(join(dir, "requests", `${name}.jsonl`), `${rows.join("\n")}\n`);
  }
  const out = apiSpeed(dir, now, 24 * 3600_000);
  assert.equal(MIN_OWN_CALLS, 10);
  // Messages: his 3 opens of the window and his newest 7 before it (230, 240 and 5 shown); the 900 ms open is older than those 10, and a
  // box walk's and a read ahead's lines count nowhere.
  assert.equal(out.metrics.thread_open_p90_ms_messages, 240);
  assert.equal(out.metricSources.messages, "GET /api/c/:id/items: the owner's devices, his newest 10 requests, from 2026-11-22 05:30Z to 2026-11-23 18:30Z, since only 3 of his requests in the window reached it, 7 of them behind a page the screen already showed (0 ms)");
  // Replies: no open of his in the window, so his 4 of the log's days, never the server's 2 ms plus a network time.
  assert.equal(out.metrics.thread_open_p90_ms_replies, 350);
  assert.equal(out.metricSources.replies, "GET /api/c/:id/replies/:root: the owner's devices, his newest 4 requests, from 2026-11-22 05:30Z to 2026-11-22 08:30Z, since he made none in the window, 2 of them behind a page the screen already showed (0 ms)");
  // Search: 10 of his in the window are enough, so his 5,000 ms search of the day before counts nowhere.
  assert.equal(out.metrics.search_p90_ms, 108);
  assert.equal(out.metricSources.search, "GET /api/search: the owner's devices, 10 requests");
  // Send: no send of his in the log's days, so an estimate that says so.
  assert.match(out.metricSources.send!, /^POST \/api\/c\/:id\/send: an estimate, since the owner made no request of this route in the request log's last 72 h: /);
  // A route out of every metric that he called in the window reads the same way, and /api/later, which he did not call in it, sets nothing.
  assert.equal(out.slowest[0]!.route, "GET /api/agents/:id/board");
  assert.equal(out.slowest[0]!.p90, 1200, "his newest 10 board reads: 8 shown at 0 ms, 1,200 and 1,500 ms");
  assert.ok(!out.slowest.some(s => s.route === "GET /api/later"));
  // His 1,500 ms wait, above the 1,200 ms p90 of its route, shows as a slow_call row.
  assert.deepEqual(out.flagged.filter(row => row.kind === "slow_call").map(row => row.excerpt), [
    `${new Date(hours(2)).toISOString()} GET /api/agents/dm_x/board waited 1500 ms on the owner's page, 212 ms of it on the network, above the p90 of 1200 ms its route reads`,
  ]);
  // A route with a line of his in the log's days gets no probe of the live server.
  const all = readTimings(dir, now, 72 * 3600_000);
  const before = ownBefore(all, hours(24));
  assert.deepEqual(unmeasured(routeSpeeds(all.filter(t => t.at >= hours(24))), before), []);
  assert.deepEqual(unmeasured(routeSpeeds([]), before), []);
  assert.deepEqual(unmeasured(routeSpeeds([]), []), ["GET /api/search", "GET /api/c/:id/items", "GET /api/c/:id/replies/:root"]);
});

test("a wait of the owner's over 1 s that his route's p90 hides is one slow_call row per route, with how many passed 1 s", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  const now = Date.UTC(2026, 10, 23, 21, 30);
  const row = (r: string, ms: number, more: Record<string, unknown> = {}) =>
    JSON.stringify({ at: now - 3600_000, src: "client", via: "tailnet", m: "GET", r, p: r, s: 200, ms, net: 220, ...more });
  writeFileSync(join(dir, "requests", "2026-11-23.jsonl"), `${[
    ...Array.from({ length: 20 }, () => row("/api/later", 220)), row("/api/later", 4067), row("/api/later", 3000),
    row("/api/rooms", 5000, { hid: 4500 }), row("/api/me", 9000, { bg: "shown" }), row("/api/me", 9000, { via: "local" }),
  ].join("\n")}\n`);
  const out = apiSpeed(dir, now, 24 * 3600_000);
  assert.equal(out.routes.find(s => s.route === "GET /api/later")?.p90, 220);
  assert.deepEqual(out.flagged.filter(row => row.kind === "slow_call").map(row => [row.sig, row.excerpt]), [[
    "slow_call:GET /api/later",
    `${new Date(now - 3600_000).toISOString()} GET /api/later waited 4067 ms on the owner's page, 220 ms of it on the network, above the p90 of 220 ms its route reads; 2 of his waits on this route in the window passed 1000 ms`,
  ]]);
});

test("a red reading with no call of the owner's since the run before gets no push until his newest line leaves the 72 h lookback", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "requests"));
  const metrics: DutyMetric[] = [
    { key: "slowest_api_p90_ms", label: "slowest", op: "<=", target: 1000, headline: true },
    { key: "search_p90_ms", label: "search", op: "<=", target: 260 },
    { key: "failed_sends_24h", label: "failed", op: "<=", target: 0 },
  ];
  const counted = new Set(metrics.map(metric => metric.key));
  const minute = 60_000;
  // His GET /api/usage waits of 23:27 KST on 11-23 and 7 searches of that day, then no call: the push runs of 19:32 and 20:03 KST on 11-24.
  const usageAt = Date.UTC(2026, 10, 23, 14, 27);
  const row = (r: string, ms: number, at: number) => ({ at, src: "client", via: "tailnet", m: "GET", r, p: r, s: 200, ms, net: 212 });
  const rows = [
    ...[3631, 3500, 3400].map((ms, i) => row("/api/usage", ms, usageAt + i * 1000)),
    ...[293, 280, 270, 250, 240, 230, 220].map((ms, i) => row("/api/search", ms, usageAt - (i + 1) * minute)),
  ];
  const write = (): void => {
    for (const name of new Set(rows.map(line => new Date(line.at).toISOString().slice(0, 10))))
      writeFileSync(join(dir, "requests", `${name}.jsonl`), `${rows.filter(line => new Date(line.at).toISOString().startsWith(name)).map(line => JSON.stringify(line)).join("\n")}\n`);
  };
  write();
  const runAt = (at: number): DutyRunRecord => {
    const out = apiSpeed(dir, at, 24 * 3600_000);
    const judged = judge(metrics, out);
    return { duty: "d2", at, trigger: "push", ms: 1, verdict: judged.verdict, metrics: judged.metrics, summary: judged.summary };
  };
  const first = runAt(Date.UTC(2026, 10, 24, 10, 32));
  const out = apiSpeed(dir, first.at, 24 * 3600_000);
  assert.deepEqual(out.lastEventAt, { slowest_api_p90_ms: usageAt + 2000, search_p90_ms: usageAt - minute });
  assert.deepEqual(out.windowMs, { slowest_api_p90_ms: LOOKBACK_MS, search_p90_ms: LOOKBACK_MS });
  const second = runAt(first.at + 31 * minute);
  assert.equal(second.verdict, "missed");
  const quiet = [second, first];
  assert.deepEqual(metricStreaks(quiet).map(streak => [streak.key, streak.quietSince]), [["slowest_api_p90_ms", usageAt + 2000], ["search_p90_ms", usageAt - minute]]);
  assert.equal(pushMisses(quiet, counted, 30 * minute, second.at + 30 * minute), null, "no new call of his, so the interval push skips both misses");
  assert.equal(agingSince(quiet), usageAt + 2000, "the duty owes no fix job while it ages");
  const streak = metricStreaks(quiet)[0]!;
  assert.equal(overdueWindow(streak, second.at), false);
  assert.equal(overdueWindow(streak, usageAt + 2000 + LOOKBACK_MS), true, "a quiet miss still red past its window owes a fix job");
  assert.equal(agedOut(quiet, counted, second.at + 30 * minute), undefined);
  assert.equal(agedOut(quiet, counted, usageAt + 2000 + LOOKBACK_MS), usageAt + 2000 + LOOKBACK_MS, "once his newest line left the lookback, the duty gets a push");

  // Past the lookback his lines set nothing: the server's handler time is an estimate with no lastEventAt, and its red reading pushes.
  const later = usageAt + LOOKBACK_MS + 2 * 3600_000;
  rows.push({ at: later - 3600_000, src: "server", m: "GET", r: "/api/search", p: "/api/search", s: 200, ms: 1500 } as ReturnType<typeof row>);
  write();
  const estimate = runAt(later);
  assert.equal(estimate.metrics.slowest_api_p90_ms?.value, 1500);
  assert.equal(estimate.metrics.slowest_api_p90_ms?.lastEventAt, undefined);
  assert.deepEqual(pushMisses([estimate, second, first], counted, 30 * minute, later + 30 * minute), ["slowest_api_p90_ms", "search_p90_ms"]);
  rows.pop();

  // A new call of his on the route that sets the number makes the next run push again.
  rows.push(row("/api/usage", 4000, second.at + 10 * minute));
  write();
  const third = runAt(second.at + 31 * minute);
  assert.equal(third.metrics.slowest_api_p90_ms?.lastEventAt, second.at + 10 * minute);
  assert.equal(metricStreaks([third, second, first]).find(one => one.key === "slowest_api_p90_ms")?.quietSince, undefined);
  assert.deepEqual(pushMisses([third, second, first], counted, 30 * minute, third.at + 30 * minute), ["slowest_api_p90_ms"]);
  assert.equal(agingSince([third, second, first]), undefined);
});
