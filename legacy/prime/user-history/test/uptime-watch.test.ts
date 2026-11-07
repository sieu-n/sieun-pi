// Guards the off-box uptime page added after us-metal01 was down from 02:55Z to 05:01Z on 10-29 and nothing paged.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DOWN_MS, networkError, probeOnce, UPTIME_TARGETS, type TargetState, UptimeWatch, uptimeStep } from "../src/uptime-watch.ts";

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

test("11-06: us-metal02's own network loss sends ops guy one box line and no customer outage page", async () => {
  const { sent, deps, setNow } = await rig();
  const dns = new Set<string>();
  const watch = new UptimeWatch({ ...deps, host: "us-metal02", probe: async (target: { name: string }) => dns.has(target.name) ? "fetch failed (EAI_AGAIN)" : null });
  const day = (time: string) => Date.parse(`2026-11-06T${time}Z`);
  // 22:02Z to 22:17Z on 11-06 both targets got EAI_AGAIN, and the old watch paged each one's chats at 22:07Z and again at 22:17Z.
  for (let ms = day("22:00:00"); ms <= day("22:30:00"); ms += 30_000) {
    setNow(ms);
    for (const name of ["crawler", "api"]) if (ms >= day("22:02:00") && ms < day("22:17:30")) dns.add(name); else dns.delete(name);
    await watch.tick();
  }
  assert.equal(sent.length, 1, sent.map(send => send.text).join("\n"));
  assert.equal(sent[0]!.session, "01a11af8-962e-773d-a19a-ee4104011987");
  assert.match(sent[0]!.text, /^\[uptime-box-network\] us-metal02 lost its network: all 2 uptime targets failed DNS or connect at once since 22:02Z \(5 min; crawler: fetch failed \(EAI_AGAIN\), api: fetch failed \(EAI_AGAIN\)\)/);

  // A second loss 25 min later sends one more box line; one target that went dark a round before the other changes nothing.
  for (let ms = day("22:30:30"); ms <= day("22:50:00"); ms += 30_000) {
    setNow(ms);
    if (ms >= day("22:42:00") && ms < day("22:48:00")) dns.add("crawler"); else dns.delete("crawler");
    if (ms >= day("22:42:30") && ms < day("22:48:00")) dns.add("api"); else dns.delete("api");
    await watch.tick();
  }
  assert.deepEqual(sent.map(send => send.text.slice(0, 22)), ["[uptime-box-network] u", "[uptime-box-network] u"]);
});

test("one target down with an HTTP error while the other answers still pages as an outage", async () => {
  const { sent, deps, setNow } = await rig();
  const watch = new UptimeWatch({ ...deps, probe: async (target: { name: string }) => target.name === "api" ? "HTTP 502" : null });
  for (let ms = at("02:55:00"); ms <= at("03:00:00"); ms += 30_000) { setNow(ms); await watch.tick(); }
  const api = UPTIME_TARGETS.find(target => target.name === "api")!;
  assert.deepEqual(sent.map(send => send.session), api.routes.map(route => route.session));
  assert.match(sent[0]!.text, /^\[uptime-down\] https:\/\/api\.virev\.ai\/openapi\.json .*customers cannot reach the commercial API at all/);
});

test("networkError holds DNS, connect and no-answer failures, and no HTTP answer", () => {
  for (const error of ["fetch failed (EAI_AGAIN)", "fetch failed (ENOTFOUND)", "fetch failed (ECONNREFUSED)", "fetch failed (UND_ERR_CONNECT_TIMEOUT)", "no answer in 300 s"]) {
    assert.equal(networkError(error), true, error);
  }
  for (const error of ["HTTP 502", 'HTTP 200 with status="degraded"']) assert.equal(networkError(error), false, error);
});
