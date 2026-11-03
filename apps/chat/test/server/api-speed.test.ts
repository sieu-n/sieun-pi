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
import { apiSpeed } from "../../scripts/duties/api-speed.ts";
import { RequestLog, type RequestTiming } from "../../server/request-log.ts";
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
    await new Promise(resolve => setTimeout(resolve, 50));
    const logged = lines(dataDir);
    const server = logged.find(line => line.src === "server" && line.p === `/api/c/${room}/items`);
    assert.equal(server?.r, "/api/c/:id/items");
    assert.equal(server?.s, 200);
    assert.ok(server!.ms >= 0);
    assert.ok(!logged.some(line => line.p === "/api/timings"), "the timings post itself is not logged");
    const client = logged.filter(line => line.src === "client");
    assert.deepEqual(client.map(line => [line.r, line.p, line.ms, line.net]), [["/api/c/:id/items", `/api/c/${room}/items`, 420, 12], ["/api/search", "/api/search", 90, undefined]]);
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
  });
  assert.equal(out.metricSources.send, "server, 1 requests");
  assert.deepEqual(out.slowest.map(s => s.route), ["GET /api/c/:id/replies/:root", "GET /api/search", "GET /api/c/:id/items"]);
  assert.equal(out.flagged.length, 3);
  assert.match(out.flagged[0]!.excerpt, /replies.*p90 2500 ms.*dm_x\/replies\/p1; its network time, the server's included, was p90 30 ms, p50 8 ms/);
  assert.doesNotMatch(out.flagged[1]!.excerpt, /network/, "a route with no network times names none");
});
