// Guards the off-box uptime page added after us-metal01 was down from 02:55Z to 05:01Z on 10-29 and nothing paged.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DOWN_MS, probeOnce, UPTIME_TARGETS, type TargetState, UptimeWatch, uptimeStep } from "../src/uptime-watch.ts";

const at = (time: string) => Date.parse(`2026-10-29T${time}Z`);
const crawler = UPTIME_TARGETS.find(target => target.name === "crawler")!;

test("every target pages a chat the routes know, and ops guy", () => {
  for (const target of UPTIME_TARGETS) {
    assert.ok(target.routes.every(route => route?.session), target.name);
    assert.ok(target.routes.some(route => route.chat === "ops guy"), target.name);
  }
  assert.deepEqual(crawler.routes.map(route => route.chat), ["Crawler VP", "api portal vp", "ops guy"]);
});

test("the 10-28 blip of 3 min 7 s does not page, and 5 min with no good answer pages once", () => {
  let state: TargetState = { lastPass: Date.parse("2026-10-28T03:14:31Z"), firstFail: null, lastFail: null, pagedAt: null };
  const sends: (string | null)[] = [];
  for (const time of ["03:15:01", "03:16:31", "03:17:31"]) {
    const step = uptimeStep(state, { startedAt: Date.parse(`2026-10-28T${time}Z`) - 30_000, at: Date.parse(`2026-10-28T${time}Z`), error: "HTTP 502" });
    state = step.state; sends.push(step.send);
  }
  const back = uptimeStep(state, { startedAt: Date.parse("2026-10-28T03:18:00Z"), at: Date.parse("2026-10-28T03:18:08Z"), error: null });
  assert.deepEqual([...sends, back.send], [null, null, null, null]);

  state = { lastPass: at("02:55:10"), firstFail: null, lastFail: null, pagedAt: null };
  const down: (string | null)[] = [];
  for (let ms = at("02:55:40"); ms <= at("03:01:10"); ms += 30_000) {
    const step = uptimeStep(state, { startedAt: ms, at: ms + 50, error: "fetch failed (ECONNREFUSED)" });
    state = step.state; down.push(step.send);
  }
  assert.equal(down.filter(send => send === "down").length, 1);
  assert.equal(state.pagedAt! - at("02:55:10") >= DOWN_MS, true);
  assert.equal(state.pagedAt! - at("02:55:10") < DOWN_MS + 30_000 + 50, true);
});

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "uptime-watch-"));
  const sent: { session: string; text: string }[] = [];
  let now = at("02:55:00");
  let failing = new Set<string>();
  const deps = { stateFile: join(dir, "uptime-watch.json"), overrideFile: join(dir, "uptime-targets.json"), log: () => {},
    deliver: async (session: string, text: string) => { sent.push({ session, text }); },
    probe: async (_target: unknown, url: string) => failing.has(url) ? "HTTP 404" : null, now: () => now };
  return { dir, sent, deps, setNow: (ms: number) => { now = ms; }, fail: (urls: string[]) => { failing = new Set(urls); } };
}

test("a forced URL pages the owning chats and ops guy within the window, says it is a test, and clears", async () => {
  const { sent, deps, setNow, fail } = await rig();
  const forcedUrl = "https://crawler.virev.ai/__uptime-forced-failure";
  await writeFile(deps.overrideFile, JSON.stringify({ crawler: forcedUrl }));
  fail([forcedUrl]);
  const watch = new UptimeWatch(deps);
  for (let ms = at("02:55:00"); ms < at("03:00:00"); ms += 30_000) { setNow(ms); await watch.tick(); }
  assert.equal(sent.length, 0);
  setNow(at("03:00:00")); await watch.tick();
  assert.deepEqual(sent.map(send => send.session), crawler.routes.map(route => route.session));
  assert.match(sent[0]!.text, /^\[uptime-down\] https:\/\/crawler\.virev\.ai\/__uptime-forced-failure has given no good answer since 02:55Z \(5 min\)/);
  assert.match(sent[0]!.text, /every customer crawl call through api\.virev\.ai fails/);
  assert.match(sent[0]!.text, /so this is a test\.$/);
  setNow(at("03:00:30")); await watch.tick();
  assert.equal(sent.length, 3);

  // A restart while it pages keeps the page, so the answer-again line still follows.
  fail([]);
  const restarted = new UptimeWatch(deps);
  setNow(at("03:01:00")); await restarted.tick();
  assert.equal(sent.length, 6);
  assert.match(sent[3]!.text, /^\[uptime-up\] https:\/\/crawler\.virev\.ai\/__uptime-forced-failure answers again at 03:01Z; it gave no good answer from 02:55Z \(6 min\)/);
  assert.equal(JSON.parse(await readFile(deps.stateFile, "utf8")).crawler.pagedAt, null);
});

test("a restart with no page starts fresh, so an old lastPass does not page at the first failure", async () => {
  const { sent, deps, setNow, fail } = await rig();
  await writeFile(deps.stateFile, JSON.stringify({ api: { lastPass: at("01:00:00"), firstFail: null, lastFail: null, pagedAt: null } }));
  fail(["https://api.virev.ai/openapi.json"]);
  setNow(at("03:00:00"));
  await new UptimeWatch(deps).tick();
  assert.equal(sent.length, 0);
});

test("probeOnce passes a good crawler body and names each kind of failure", async () => {
  let reply: [number, string] = [200, '{"status":"ok"}'];
  const server = createServer((_request, response) => { response.writeHead(reply[0], { "content-type": "application/json" }); response.end(reply[1]); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/health`;
  try {
    assert.equal(await probeOnce(crawler, url), null);
    reply = [200, '{"status":"degraded"}'];
    assert.equal(await probeOnce(crawler, url), 'HTTP 200 with status="degraded"');
    reply = [503, "{}"];
    assert.equal(await probeOnce(crawler, url), "HTTP 503");
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  const closed = createServer();
  await new Promise<void>(done => closed.listen(0, "127.0.0.1", done));
  const port = (closed.address() as { port: number }).port;
  await new Promise(done => closed.close(done));
  assert.match((await probeOnce(crawler, `http://127.0.0.1:${port}/health`))!, /^fetch failed \(ECONNREFUSED\)$/);
});
