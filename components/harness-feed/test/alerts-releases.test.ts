import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promName, type Context, type Sample } from "../otlp.ts";
import { briefSamples, bridgeSamples, parseBridge, toolSamples, parseChatJobs, parseWake, procStart, read, resumeSamples, sdkView, statusSamples, supervisorStart, wakeSamples } from "../readers/alerts-releases.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/alerts-releases/home", import.meta.url));
const NOW = 1792430000000;
const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";

const value = (samples: readonly Sample[], name: string, labels: Record<string, string> = {}): number | undefined =>
  samples.find(s => s.name === name && Object.entries(labels).every(([key, want]) => s.labels?.[key] === want))?.value;

/** The fixture home in a temp folder, with the `current` symlink and a relay.json naming a fake daemon socket that says `hello`. */
async function home(t: { after(fn: () => void): void }, hello: object | null): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "alerts-releases-"));
  cpSync(FIXTURE, dir, { recursive: true });
  symlinkSync("release-abc1234", join(dir, ".local/share/sieun-pi-chat/current"));
  // A node_modules path, which .gitignore keeps out of the fixture folder.
  const sdk = join(dir, ".local/share/sieun-pi-chat/release-abc1234/components/user-history/node_modules/prime-agent");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "prime-agent", version: "0.9.8" }));
  const socket = join(dir, "daemon.sock");
  const server = createServer(connection => { if (hello) connection.write(`${JSON.stringify(hello)}\n`); });
  await new Promise<void>(done => server.listen(socket, done));
  const config = join(dir, ".config/prime-relay");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "relay.json"), JSON.stringify({ daemonSocket: socket }));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

const context = (dir: string, chatHost: boolean): Context => ({ home: dir, host: "t", platform: process.platform, now: NOW, chatHost, state: new Map() });

test("the chat host round reads the bridge, resumes, wakes, releases and the daemon from the fixture home", async t => {
  const start = "Sun Oct 18 11:19:37 2026";
  const dir = await home(t, { type: "daemon_hello", appVersion: "0.9.8", supervisorProcessStartId: `ps:${start}` });
  const samples = await read(context(dir, true));
  assert.equal(value(samples, "harness.prime.daemon_up"), 1);
  assert.equal(value(samples, "harness.prime.daemon_uptime"), (NOW - Date.parse(start)) / 1000);
  assert.equal(value(samples, "harness.prime.daemon_version", { version: "0.9.8" }), 1);
  assert.equal(value(samples, "harness.prime.relay_up"), undefined, "a relay.json with no listen address reads no relay");

  assert.equal(value(samples, "harness.alerts.bridge_ok"), 1);
  assert.equal(value(samples, "harness.alerts.grafana_firing"), 33);
  assert.equal(value(samples, "harness.alerts.last_good_poll_age"), 15);
  const crawler = { chat: "Crawler VP" };
  assert.deepEqual(["firing_rules", "owed_rules", "held_rules", "waiting_rules", "escalated_rules", "fired_30m", "triage_jobs", "triage_no_turn"]
    .map(name => value(samples, `harness.alerts.${name}`, crawler)), [3, 1, 1, 1, 1, 2, 1, 1]);
  assert.equal(value(samples, "harness.alerts.oldest_firing", crawler), 3600);
  assert.equal(value(samples, "harness.alerts.owed_rules", { chat: "ops guy" }), 1);

  assert.equal(value(samples, "harness.resume.held"), 4);
  assert.equal(value(samples, "harness.resume.held_by", { chat: "Crawler VP", reason: "error" }), 2);
  assert.equal(value(samples, "harness.resume.held_by", { chat: "ops guy", reason: "hung" }), 1);
  assert.equal(value(samples, "harness.resume.held_by", { chat: "other", reason: "cut_off" }), 1);
  assert.equal(value(samples, "harness.resume.saved_jobs", crawler), 1);

  assert.equal(value(samples, "harness.wakes.pending", { chat: "Crawler VP", kind: "time" }), 2);
  assert.equal(value(samples, "harness.wakes.pending", { chat: "other", kind: "run" }), 1);
  assert.equal(value(samples, "harness.wakes.overdue", crawler), 1);
  assert.equal(value(samples, "harness.wakes.most_late"), 300);

  assert.equal(value(samples, "harness.release.info", { release: "release-abc1234", role: "live" }), 1);
  assert.equal(value(samples, "harness.release.restart_pending"), 0);
  assert.equal(value(samples, "harness.release.age"), 800);
  assert.equal(value(samples, "harness.release.build_to_restart"), 20);
  assert.equal(value(samples, "harness.release.lock_held"), 0, "the lock's pid is gone");
  assert.equal(value(samples, "harness.release.client_version", { version: "0.9.8" }), 1);
  assert.deepEqual(["sdk_matched", "sdk_auto", "sdk_update_failed"].map(name => value(samples, `harness.release.${name}`)), [1, 0, 1]);

  for (const sample of samples) {
    assert.ok(Number.isFinite(sample.value), sample.name);
    assert.ok(!Object.values(sample.labels ?? {}).some(label => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(label)), `${sample.name} carries a session id label`);
  }
  assert.equal(promName(samples.find(s => s.name === "harness.release.chat_uptime") ?? { name: "harness.release.chat_uptime", kind: "gauge", unit: "s" }), "harness_release_chat_uptime_seconds");
});

test("off the chat host only the daemon and relay read, and a silent daemon reads down", async t => {
  const dir = await home(t, null);
  const samples = await read(context(dir, false));
  assert.deepEqual(samples.map(s => s.name), ["harness.prime.daemon_up"]);
  assert.equal(samples[0]!.value, 0);
});

test("a version 4 bridge state keeps its triage jobs apart, and a job that is not the chat's current one and never ran owes the fire", () => {
  const state = parseBridge({ v: 4, rules: {
    a: { chat: "c", wokeAt: 10, firstWokeAt: 10, instances: {}, job: { id: "old", at: 20 } },
    b: { chat: "c", wokeAt: 10, firstWokeAt: 10, instances: {}, job: { id: "cur", at: 20 } },
  }, jobs: { old: { chat: "c", at: 5 }, cur: { chat: "c", at: 20, ranAt: 30 } }, chats: { c: "cur" } })!;
  const samples = bridgeSamples(state, 100, () => "chat");
  assert.equal(value(samples, "harness.alerts.owed_rules"), 1);
  assert.equal(value(samples, "harness.alerts.held_rules"), 1);
  assert.equal(value(samples, "harness.alerts.triage_no_turn"), 0);
  assert.equal(parseBridge({ v: 9, rules: {} }), null);
});

test("the bridge status reads stale and down from the watchdog's fields", () => {
  const samples = statusSamples({ ts: new Date(NOW - 200_000).toISOString(), health: "stale", last_ok: new Date(NOW - 600_000).toISOString(), firing_count: null,
    alert_since: new Date(NOW - 600_000).toISOString() }, NOW, 0);
  assert.equal(value(samples, "harness.alerts.bridge_ok"), 0);
  assert.equal(value(samples, "harness.alerts.bridge_health", { state: "stale" }), 1);
  assert.equal(value(samples, "harness.alerts.status_age"), 200);
  assert.equal(value(samples, "harness.alerts.bridge_down"), 600);
  assert.equal(value(samples, "harness.alerts.grafana_firing"), undefined);
});

test("a resume list older than two job sweeps holds nothing, as readHeldTurns reads it", () => {
  const runs = [{ session: "s", reason: "error" }];
  assert.equal(value(resumeSamples({ at: NOW - 20 * 60_000, runs }, NOW, () => "x"), "harness.resume.held"), 1);
  const stale = resumeSamples({ at: NOW - 22 * 60_000, runs }, NOW, () => "x");
  assert.equal(value(stale, "harness.resume.held"), 0);
  assert.equal(value(stale, "harness.resume.pass_age"), 22 * 60);
});

test("wakes parse as src/wakes.ts does, and a time wake counts overdue only after two ticks", () => {
  assert.equal(parseWake({ session: "s", on: { kind: "run", run: "x" } }), null);
  const wakes = [parseWake({ session: "s", on: { kind: "time", at: NOW - 59_000 } })!, parseWake({ session: "s", on: { kind: "time", at: NOW - 61_000 } })!];
  const samples = wakeSamples(wakes, NOW, () => "c", () => "chat", NOW - 1000);
  assert.equal(value(samples, "harness.wakes.overdue", { chat: "chat" }), 1);
  assert.equal(value(samples, "harness.wakes.ticker_age"), 1);
});

test("process start times read from /proc stat ticks and from macOS ps lstart", () => {
  assert.equal(supervisorStart("proc:41656070", 1_000_000), 1_000_000 + 416_560_700);
  assert.equal(supervisorStart("proc:5", null), undefined);
  assert.equal(supervisorStart("ps:Sun Oct 18 11:19:37 2026", null), Date.parse("Sun Oct 18 11:19:37 2026"));
  const fields = Array.from({ length: 50 }, (_, index) => String(index + 3));
  fields[19] = "12345";
  assert.equal(procStart(`77 (node (x) y) ${fields.join(" ")}`, 1000), 1000 + 123_450);
});

test("the Updates pane counts a daemon version that is not x.y.z as matched, and a failed target only for that daemon version", () => {
  assert.deepEqual(sdkView("0.9.8-daemon-fix.1-mem.3", "0.9.8", { auto: false, failedTarget: "0.9.8" }), { matched: true, auto: false, failed: false });
  assert.deepEqual(sdkView("0.10.1", "0.9.8", { shipped: { daemon: "0.10.1", sdk: "0.9.8" } }), { matched: true, auto: true, failed: false });
  assert.deepEqual(sdkView("0.10.1", "0.9.8", {}), { matched: false, auto: true, failed: false });
});

test("a chat's name is the one its latest job was filed under", () => {
  const { names, jobChat } = parseChatJobs({ jobs: { a: { chat: "old", at: 1, chatId: CRAWLER }, b: { chat: "new", at: 2, chatId: CRAWLER }, c: { chat: "x" } } });
  assert.equal(names.get(CRAWLER), "new");
  assert.equal(jobChat.get("a"), CRAWLER);
  assert.equal(jobChat.has("c"), false);
});

test("the Tools page's last live run reads as failing checks out of all per box and tool, boxes that did not answer, and its age", () => {
  const samples = toolSamples({ checkedAt: NOW - 90_000, registryError: null, hosts: [
    { name: "us-metal02", self: true, state: "checked", checkedAt: NOW, tools: [
      { tool: "websearch", used: true, checks: [{ id: "websearch_kernel", tool: "w", status: "pass", detail: "", ms: 120 }, { id: "websearch_query", tool: "w", status: "fail", detail: "", ms: 2000 }] },
      { tool: "cua-driver", used: false }] },
    { name: "mbp", self: false, state: "unreachable", checkedAt: NOW, error: "ssh mac exit 255", tools: [{ tool: "aside", used: true, checks: [] }] },
  ] }, NOW);
  assert.equal(value(samples, "harness.tools.check_age"), 90);
  assert.equal(value(samples, "harness.tools.checks", { host: "us-metal02", tool: "websearch" }), 2);
  assert.equal(value(samples, "harness.tools.failing", { host: "us-metal02", tool: "websearch" }), 1);
  assert.equal(value(samples, "harness.tools.checks", { tool: "cua-driver" }), undefined, "a tool the box does not use is not counted");
  assert.equal(value(samples, "harness.tools.host_unreachable", { host: "mbp" }), 1);
  assert.equal(value(samples, "harness.tools.check_duration", { check: "websearch_query" }), 2);
  assert.deepEqual(toolSamples(undefined, NOW), []);
});

test("Chat rules count a chat behind when its last loaded brief is not the live one, or it has none on record", () => {
  const samples = briefSamples("abcd1234", ["a", "b", "c"], { briefs: { a: "abcd1234", b: "00000000" } }, id => id);
  assert.equal(value(samples, "harness.release.brief_behind"), 2);
  assert.equal(value(samples, "harness.release.brief_up_to_date", { chat: "a" }), 1);
});
