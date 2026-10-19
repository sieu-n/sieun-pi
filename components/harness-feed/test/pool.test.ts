import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Context, Sample } from "../otlp.ts";
import { accountSamples, catchUpUsage, hourSamples, queueSamples, read, readPool, usageLog, usageSamples, type PoolPart } from "../readers/pool.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pool");
const snapshot = JSON.parse(readFileSync(join(FIXTURES, "snapshot.json"), "utf8"));
const parsed = (part: PoolPart): unknown => JSON.parse(part.out);
/** The fixture's clock, in epoch ms. */
const NOW = 1792430000 * 1000;
const value = (samples: Sample[], name: string, labels: Record<string, string> = {}): number | undefined =>
  samples.find(s => s.name === name && Object.entries(labels).every(([key, want]) => s.labels?.[key] === want))?.value;

test("queue samples count working turns by kind and class, waiting turns by class, and the busiest tree", () => {
  const samples = queueSamples(parsed(snapshot.queue), NOW);
  assert.equal(value(samples, "harness.pool.queue_on"), 1);
  assert.equal(value(samples, "harness.pool.working_max"), 30);
  assert.equal(value(samples, "harness.pool.tree_working_max"), 16);
  assert.equal(value(samples, "harness.pool.slots_used"), 3);
  assert.equal(value(samples, "harness.pool.turns_working", { kind: "slot", priority: "high" }), 1);
  assert.equal(value(samples, "harness.pool.turns_working", { kind: "borrow", priority: "high" }), 1);
  assert.equal(value(samples, "harness.pool.turns_working", { kind: "owner", priority: "normal" }), 1);
  assert.equal(value(samples, "harness.pool.turns_working", { kind: "prod", priority: "low" }), 0);
  assert.equal(samples.filter(s => s.name === "harness.pool.turns_working").length, 15);
  assert.equal(value(samples, "harness.pool.turns_waiting", { priority: "high" }), 1);
  assert.equal(value(samples, "harness.pool.turns_waiting", { priority: "normal" }), 0);
  assert.equal(value(samples, "harness.pool.turns_waiting", { priority: "low" }), 1);
  assert.equal(value(samples, "harness.pool.tree_working_most"), 3);
  assert.equal(value(samples, "harness.pool.trees_working"), 2);
  assert.equal(value(samples, "harness.pool.queue_wait_longest"), 79);
  assert.equal(value(samples, "harness.pool.turn_working_longest"), 120);
});

test("an empty queue reads zeros, not -Infinity", () => {
  const samples = queueSamples({ enabled: false, working_max: 16, tree_working_max: 8, slots_used: 0, working: [], queued: [] }, NOW);
  assert.equal(value(samples, "harness.pool.queue_wait_longest"), 0);
  assert.equal(value(samples, "harness.pool.tree_working_most"), 0);
  assert.equal(value(samples, "harness.pool.turn_working_longest"), 0);
});

test("account samples match the Accounts table and the sidebar meters", () => {
  const config = { admit_5h_max_pct: 70, low_admit_5h_max_pct: 50, seven_day_max_pct: 98 };
  const samples = accountSamples("anthropic", parsed(snapshot.threads[0].ls.anthropic), config, NOW);
  const one = { account: "one@example.com", provider: "anthropic" }, two = { account: "two@example.com (team)", provider: "anthropic" };
  assert.equal(value(samples, "harness.pool.account_window_used", { ...one, window: "5h" }), 0.4);
  assert.equal(value(samples, "harness.pool.account_window_used", { ...two, window: "week" }), 0.3);
  assert.equal(value(samples, "harness.pool.account_usable", one), 1);
  assert.equal(value(samples, "harness.pool.account_state", { ...one, state: "ready" }), 1);
  assert.equal(value(samples, "harness.pool.account_state", { ...two, state: "limited" }), 1);
  assert.equal(value(samples, "harness.pool.account_state", { account: "three@example.com", state: "off" }), 1);
  assert.equal(value(samples, "harness.pool.account_blocked", two), 3600);
  assert.equal(value(samples, "harness.pool.account_blocked", one), 0);
  assert.equal(value(samples, "harness.pool.account_threads", one), 3);
  assert.equal(value(samples, "harness.pool.account_held_trees", one), 2);
  assert.equal(value(samples, "harness.pool.account_usage_age", one), 100);
  assert.equal(value(samples, "harness.pool.account_resets_left", one), 3);
  assert.equal(value(samples, "harness.pool.account_resets_left", two), undefined);
  assert.equal(value(samples, "harness.pool.account_window_resets", { ...one, window: "5h" }), 3600);
  assert.equal(value(samples, "harness.pool.account_window_resets", { ...one, window: "week" }), 86400);
  assert.equal(samples.filter(s => s.name === "harness.pool.next_request_account").length, 0);
  // The sidebar: the off account drops out, the limited one counts full in both meters.
  assert.equal(value(samples, "harness.pool.provider_used", { provider: "anthropic", window: "5h" }), 0.7);
  assert.equal(value(samples, "harness.pool.provider_used", { provider: "anthropic", window: "week" }), 0.6);
  assert.equal(value(samples, "harness.pool.provider_usable_accounts", { provider: "anthropic" }), 1);
  assert.equal(value(samples, "harness.pool.provider_accounts", { provider: "anthropic" }), 2);
  assert.equal(value(samples, "harness.pool.provider_next_free", { provider: "anthropic" }), 3600);
});

test("the next-request account comes from who with no session, and none when the pool waits", () => {
  const who = parsed(snapshot.threads[0].who);
  const claude = accountSamples("anthropic", parsed(snapshot.threads[0].ls.anthropic), null, NOW, who).filter(s => s.name === "harness.pool.next_request_account");
  assert.deepEqual(claude.map(s => [s.labels, s.value]), [[{ account: "one@example.com", provider: "anthropic" }, 1]]);
  const codex = accountSamples("openai-codex", parsed(snapshot.threads[0].ls["openai-codex"]), null, NOW, who).filter(s => s.name === "harness.pool.next_request_account");
  assert.deepEqual(codex.map(s => s.labels), [{ account: "none", provider: "openai-codex" }]);
  const failed = accountSamples("anthropic", parsed(snapshot.threads[0].ls.anthropic), null, NOW, { providers: { anthropic: { error: "no index" } } });
  assert.equal(failed.some(s => s.name === "harness.pool.next_request_account"), false);
});

test("a window with no reset time or one already past sends no reset series", () => {
  const listing = { provider: "anthropic", rows: [{ id: "x", email: "x@example.com", usable: true, windows: [
    { kind: "session", label: "5h", pct: 10, resets_at: null }, { kind: "weekly", label: "week", pct: 10, resets_at: NOW / 1000 - 5 }] }] };
  assert.equal(accountSamples("anthropic", listing, null, NOW).some(s => s.name === "harness.pool.account_window_resets"), false);
});

const usageValue = (samples: Sample[], name: string, run?: string): number | undefined => value(samples, name, run ? { run } : {});

test("the first scan of pi-pool.log sets the last refresh and sample but counts none as recent", async () => {
  const log = usageLog();
  await catchUpUsage(log, join(FIXTURES, "usage.log"), NOW);
  const samples = usageSamples(log);
  // The bad refresh line (accounts not a number), the turn line that names usage_sample and the cut line are skipped.
  assert.equal(usageValue(samples, "harness.pool.usage_read_accounts", "refresh"), 30);
  assert.equal(usageValue(samples, "harness.pool.usage_read_failed", "refresh"), 2);
  assert.equal(usageValue(samples, "harness.pool.usage_read_accounts", "sample"), 1);
  assert.equal(usageValue(samples, "harness.pool.usage_read_failed", "sample"), 0);
  assert.equal(usageValue(samples, "harness.pool.usage_reads_recent", "refresh"), 0);
  assert.equal(usageValue(samples, "harness.pool.usage_reads_recent", "sample"), 0);
  assert.deepEqual(samples.filter(s => s.name === "harness.pool.usage_refresh_failed_account").map(s => s.labels?.account), ["one@example.com", "two@example.com"]);
});

test("lines appended after the first scan count as recent for 30 min, and a cut line waits for its end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  const path = join(dir, "pi-pool.log");
  copyFileSync(join(FIXTURES, "usage.log"), path);
  const log = usageLog();
  await catchUpUsage(log, path, NOW);
  appendFileSync(path, JSON.stringify({ ts: "x", event: "usage_sample", accounts: 4, failed: ["one@example.com"] }) + "\n" + '{"ts": "x", "event": "usage_ref');
  await catchUpUsage(log, path, NOW + 60_000);
  let samples = usageSamples(log);
  assert.equal(usageValue(samples, "harness.pool.usage_reads_recent", "sample"), 1);
  assert.equal(usageValue(samples, "harness.pool.usage_read_failed_recent", "sample"), 1);
  assert.equal(usageValue(samples, "harness.pool.usage_read_accounts", "sample"), 4);
  assert.equal(usageValue(samples, "harness.pool.usage_reads_recent", "refresh"), 0);
  appendFileSync(path, 'resh", "accounts": 2, "failed": []}\n');
  await catchUpUsage(log, path, NOW + 120_000);
  samples = usageSamples(log);
  assert.equal(usageValue(samples, "harness.pool.usage_reads_recent", "refresh"), 1);
  assert.equal(usageValue(samples, "harness.pool.usage_read_failed", "refresh"), 0);
  assert.equal(samples.some(s => s.name === "harness.pool.usage_refresh_failed_account"), false);
  await catchUpUsage(log, path, NOW + 60_000 + 30 * 60_000 + 1);
  samples = usageSamples(log);
  assert.equal(usageValue(samples, "harness.pool.usage_reads_recent", "sample"), 0);
  assert.equal(usageValue(samples, "harness.pool.usage_reads_recent", "refresh"), 1);
});

test("a log that shrank is read again from the start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  const path = join(dir, "pi-pool.log");
  copyFileSync(join(FIXTURES, "usage.log"), path);
  const log = usageLog();
  await catchUpUsage(log, path, NOW);
  writeFileSync(path, JSON.stringify({ event: "usage_sample", accounts: 5, failed: [] }) + "\n");
  await catchUpUsage(log, path, NOW + 30_000);
  const samples = usageSamples(log);
  assert.equal(usageValue(samples, "harness.pool.usage_read_accounts", "sample"), 5);
  assert.equal(usageValue(samples, "harness.pool.usage_reads_recent", "sample"), 1);
  assert.equal(usageValue(samples, "harness.pool.usage_read_accounts", "refresh"), undefined);
});

test("a codex pool has no 5h meter", () => {
  const samples = accountSamples("openai-codex", parsed(snapshot.threads[0].ls["openai-codex"]), null, NOW);
  assert.deepEqual(samples.filter(s => s.name === "harness.pool.provider_used").map(s => s.labels?.window), ["week"]);
});

test("the hour now in progress gives turns finished and, with queued turns, their median wait", () => {
  assert.deepEqual(hourSamples([]), []);
  assert.deepEqual(hourSamples([{ at: 0, finished: 2, medianWaitS: 4 }, { at: 1, finished: 5, medianWaitS: null }]).map(s => [s.name, s.value]), [["harness.pool.turns_finished_hour", 5]]);
  assert.deepEqual(hourSamples([{ at: 1, finished: 5, medianWaitS: 12.5 }]).map(s => s.value), [5, 12.5]);
});

test("readPool asks for no thread on a box whose accounts live elsewhere, and falls back to the separate reads on an old pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  const asked: string[][] = [];
  const old = async (args: readonly string[]): Promise<PoolPart> => {
    asked.push([...args]);
    if (args[0] === "snapshot") return { code: 2, out: "", err: "usage: pi-pool [command] ...\n" };
    if (args[0] === "queue") return snapshot.queue;
    if (args[0] === "config") return snapshot.config;
    if (args[0] === "who") return snapshot.threads[0].who;
    return snapshot.threads[0].ls[args[3] as string];
  };
  const remote = await readPool(dir, "/nonexistent", false, old);
  assert.deepEqual(asked.map(args => args[0]), ["snapshot", "queue", "config"]);
  assert.deepEqual(asked[0], ["snapshot", "--json"]);
  assert.equal(remote.hookd, null);
  assert.deepEqual(Object.keys(remote.snapshot.ls), []);
  assert.equal(remote.snapshot.who, null);
  asked.length = 0;
  const local = await readPool(dir, "/nonexistent", true, old);
  assert.deepEqual(asked[0], ["snapshot", "--json", "--thread", "", ""]);
  assert.deepEqual(Object.keys(local.snapshot.ls).sort(), ["anthropic", "openai-codex"]);
  assert.deepEqual(asked.map(args => args.join(" ")).sort(), ["config", "ls --json --provider anthropic", "ls --json --provider openai-codex", "queue --json", "snapshot --json --thread  ", "who --json"]);
  assert.equal(local.snapshot.who, snapshot.threads[0].who);
});

test("read runs the installed CLI once with no session, and adds the hour from pi-pool.log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00:01`;
  writeFileSync(join(dir, "pi-pool.log"), [
    { ts, event: "turn_admitted", kind: "slot", waited_s: 10 }, { ts, event: "turn_admitted", kind: "slot", waited_s: 30 },
    { ts, event: "turn_admitted", kind: "owner", waited_s: 0 }, { ts, event: "turn_released" }, { ts, event: "turn_released" },
    { ts, event: "usage_refresh", providers: ["anthropic"], accounts: 3, failed: ["two@example.com (team)"], errors: {} },
  ].map(line => JSON.stringify(line)).join("\n") + "\n");
  const argv = join(dir, "argv.log");
  const saved = { dir: process.env.PI_POOL_DIR, bin: process.env.PI_POOL_BIN, log: process.env.PI_POOL_ARGV_LOG,
    session: process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID };
  Object.assign(process.env, { PI_POOL_DIR: dir, PI_POOL_BIN: join(FIXTURES, "fake-pi-pool.sh"), PI_POOL_ARGV_LOG: argv,
    PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: "a-session-the-pool-must-not-see" });
  try {
    const ctx: Context = { home: "/nonexistent", host: "t", platform: "linux", now: Date.now(), chatHost: false, state: new Map() };
    const samples = await read(ctx);
    assert.equal(readFileSync(argv, "utf8"), "snapshot --json --thread  |\n");
    assert.equal(value(samples, "harness.pool.read_ok"), 1);
    assert.equal(value(samples, "harness.pool.turns_finished_hour"), 2);
    assert.equal(value(samples, "harness.pool.queue_wait_median_hour"), 20);
    assert.equal(value(samples, "harness.pool.provider_accounts", { provider: "openai-codex" }), 1);
    assert.equal(value(samples, "harness.pool.next_request_account", { account: "one@example.com", provider: "anthropic" }), 1);
    assert.equal(value(samples, "harness.pool.usage_read_failed", { run: "refresh" }), 1);
    assert.equal(value(samples, "harness.pool.usage_refresh_failed_account", { account: "two@example.com (team)" }), 1);
    assert.equal(samples.some(s => s.name === "harness.pool.service_up"), false);
  } finally {
    for (const [key, name] of [["dir", "PI_POOL_DIR"], ["bin", "PI_POOL_BIN"], ["log", "PI_POOL_ARGV_LOG"], ["session", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID"]] as const) {
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
  }
});

test("a pool that does not answer reads read_ok 0 and no queue or accounts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  const saved = { dir: process.env.PI_POOL_DIR, bin: process.env.PI_POOL_BIN };
  Object.assign(process.env, { PI_POOL_DIR: dir, PI_POOL_BIN: "/bin/false" });
  try {
    const samples = await read({ home: "/nonexistent", host: "t", platform: "linux", now: Date.now(), chatHost: false, state: new Map() });
    assert.equal(value(samples, "harness.pool.read_ok"), 0);
    assert.equal(samples.some(s => s.name === "harness.pool.queue_on"), false);
  } finally {
    if (saved.dir === undefined) delete process.env.PI_POOL_DIR; else process.env.PI_POOL_DIR = saved.dir;
    if (saved.bin === undefined) delete process.env.PI_POOL_BIN; else process.env.PI_POOL_BIN = saved.bin;
  }
});
