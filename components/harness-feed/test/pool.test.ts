import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Context, Sample } from "../otlp.ts";
import { accountSamples, hourSamples, queueSamples, read, readPool, type PoolPart } from "../readers/pool.ts";

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
  // The sidebar: the off account drops out, the limited one counts full in both meters.
  assert.equal(value(samples, "harness.pool.provider_used", { provider: "anthropic", window: "5h" }), 0.7);
  assert.equal(value(samples, "harness.pool.provider_used", { provider: "anthropic", window: "week" }), 0.6);
  assert.equal(value(samples, "harness.pool.provider_usable_accounts", { provider: "anthropic" }), 1);
  assert.equal(value(samples, "harness.pool.provider_accounts", { provider: "anthropic" }), 2);
  assert.equal(value(samples, "harness.pool.provider_next_free", { provider: "anthropic" }), 3600);
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
    return snapshot.threads[0].ls[args[3] as string];
  };
  const remote = await readPool(dir, "/nonexistent", false, old);
  assert.deepEqual(asked.map(args => args[0]), ["snapshot", "queue", "config"]);
  assert.deepEqual(asked[0], ["snapshot", "--json"]);
  assert.equal(remote.hookd, null);
  assert.deepEqual(Object.keys(remote.snapshot.ls), []);
  asked.length = 0;
  const local = await readPool(dir, "/nonexistent", true, old);
  assert.deepEqual(asked[0], ["snapshot", "--json", "--thread", "", ""]);
  assert.deepEqual(Object.keys(local.snapshot.ls).sort(), ["anthropic", "openai-codex"]);
});

test("read runs the installed CLI once with no session, and adds the hour from pi-pool.log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00:01`;
  writeFileSync(join(dir, "pi-pool.log"), [
    { ts, event: "turn_admitted", kind: "slot", waited_s: 10 }, { ts, event: "turn_admitted", kind: "slot", waited_s: 30 },
    { ts, event: "turn_admitted", kind: "owner", waited_s: 0 }, { ts, event: "turn_released" }, { ts, event: "turn_released" },
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
