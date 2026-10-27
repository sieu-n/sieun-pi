import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promName, type Context, type Sample } from "../otlp.ts";
import { callerOf, cliHelloMisses, daemonLogName, lifecycleEvents, primeCalls, psThreadsCpu, quantiles, read, serviceEvents, statCpu } from "../readers/latency.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/latency/", import.meta.url));
const fixture = (name: string): string => readFileSync(join(FIXTURE, name), "utf8");
const NOW = Date.parse("2026-10-22T07:30:00.000Z");
const LOCAL = "us-metal02";

/** A fixture log with each `{T-<n>m}` mark turned into the stamp n minutes before NOW, and `{SOCKET}` into the test's socket. */
const stamped = (name: string, socket = ""): string => fixture(name)
  .replace(/\{T-(\d+)m\}/g, (_, minutes: string) => new Date(NOW - Number(minutes) * 60_000).toISOString())
  .replaceAll("{SOCKET}", socket);

const value = (samples: readonly Sample[], name: string, labels: Record<string, string> = {}): number | undefined =>
  samples.find(s => promName(s) === name && Object.entries(labels).every(([key, want]) => s.labels?.[key] === want))?.value;

/** A temp home with relay.json naming a fake daemon socket, the socket's lock owner, the fixture logs and a socket that says hello after `helloMs`, or never. */
async function home(t: { after(fn: () => void): void }, helloMs: number | null): Promise<{ dir: string; socket: string; logs: string; service: string }> {
  const dir = mkdtempSync(join(tmpdir(), "latency-"));
  const socket = join(dir, "daemon.sock");
  const open = new Set<import("node:net").Socket>();
  const server: Server = createServer(connection => {
    open.add(connection);
    connection.on("close", () => open.delete(connection));
    if (helloMs !== null) setTimeout(() => connection.write(`${JSON.stringify({ type: "daemon_hello", supervisorPid: process.pid })}\n`), helloMs);
  });
  await new Promise<void>(done => server.listen(socket, done));
  mkdirSync(join(dir, ".config/prime-relay"), { recursive: true });
  writeFileSync(join(dir, ".config/prime-relay/relay.json"), JSON.stringify({ daemonSocket: socket }));
  mkdirSync(`${socket}.lock`);
  writeFileSync(`${socket}.lock/owner.json`, JSON.stringify({ version: 1, pid: process.pid }));
  const logs = join(dir, ".prime/agent/logs");
  mkdirSync(logs, { recursive: true });
  mkdirSync(join(dir, ".prime/agent/browser-chat"), { recursive: true });
  writeFileSync(join(logs, daemonLogName(socket)), fixture("daemon-before.log"));
  writeFileSync(join(logs, "client-errors.log"), stamped("client-errors-before.log", socket));
  const service = join(dir, ".prime/agent/browser-chat/service.log");
  writeFileSync(service, stamped("service-before.log"));
  t.after(() => { for (const connection of open) connection.destroy(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, socket, logs, service };
}

const context = (dir: string, state = new Map<string, unknown>()): Context => ({ home: dir, host: LOCAL, platform: process.platform, now: NOW, chatHost: true, state });
const until = async (check: () => boolean) => { while (!check()) await new Promise(done => setImmediate(done)); };

test("the callers of service.log timeouts come from each writer's line prefix", () => {
  assert.equal(callerOf("job 01a0f0dd: wake: Timed out after 30000ms"), "job wake");
  assert.equal(callerOf("open 01a0f0ee on mac saved 172 messages: catalog 240ms"), "open");
  assert.equal(callerOf("catalog schedules: Timed out after 30000ms"), "catalog schedules");
  assert.equal(callerOf("hosts: copy mac: Timed out after 10000ms"), "hosts copy");
  assert.equal(callerOf("idle unload: 01a0f100-0000-7000-8000-000000000002: Error: Timed out"), "idle unload");
  assert.equal(callerOf("01a0f100-0000-7000-8000-000000000002: something new"), "other");
});

test("serviceEvents times attaches, worker starts and full lists, and books each timeout on its caller, method, limit and box", () => {
  const { calls, timeouts } = serviceEvents(stamped("service-after.log").split("\n"), LOCAL);
  const keys = timeouts.map(t => `${t.caller}|${t.method}|${t.limit}|${t.host}`);
  assert.deepEqual(keys, ["job wake|attach|30s|us-metal02", "open|hello|3s|mac", "outbox|hello|10s|mac", "idle unload|get_state|30s|us-metal02",
    "daemon gate|list|30s|us-metal02", "pin|list|30s|us-metal02", "pin|list|30s|us-metal02"]);
  assert.deepEqual(calls.map(c => `${c.method}|${c.host}|${c.s}`), ["attach|us-metal02|30", "list|us-metal02|30", "list|us-metal02|30", "list|us-metal02|30", "reload|us-metal02|0.6"]);
  const before = serviceEvents(stamped("service-before.log").split("\n"), LOCAL);
  assert.deepEqual(before.calls.map(c => `${c.method}|${c.host}|${c.s}`), ["resume|us-metal02|7", "resume|mac|0.4", "create|us-metal02|11.2", "attach|us-metal02|2.091", "list|mac|13.5"]);
  // A worker start is stamped when it began, so its call ends `s` later; an unstamped open takes the last stamp.
  assert.equal(before.calls[2]!.at, NOW - 5 * 60_000 + 11_200);
  assert.equal(before.calls[3]!.at, NOW - 5 * 60_000);
  assert.deepEqual(before.timeouts.map(t => t.method), ["cron_list"]);
});

test("the supervisor log's lines count as starts, stops, crashes, evictions and failed adoptions", () => {
  assert.deepEqual(Object.fromEntries(lifecycleEvents(fixture("daemon-after.log").split("\n"))), { worker_stop: 1, worker_stop_error: 1, worker_start: 1,
    worker_evicted: 1, worker_stop_timed_out: 1, worker_adopt_failed: 1, supervisor_start: 1 });
});

test("CPU seconds come from a /proc stat line and from ps -M's first thread row on macOS", () => {
  assert.equal(statCpu(fixture("proc-stat.txt")), (197345 + 63174) / 100);
  const cpu = psThreadsCpu(fixture("ps-M-mac.txt"))!;
  assert.equal(cpu.main.toFixed(2), (12 * 60 + 58.57 + 21 * 60 + 42.94).toFixed(2));
  assert.equal(cpu.all.toFixed(2), (12 * 60 + 58.57 + 21 * 60 + 42.94 + 85.08 + 405.29 + 14.54 + 27.22).toFixed(2));
});

test("the daemon log name is Prime's getDaemonLogPath, and CLI hello misses count only for this box's socket", () => {
  assert.equal(daemonLogName("/tmp/prime-agent-1001/daemon.sock"), "daemon.sock.ee92e1d8.log");
  assert.equal(daemonLogName("/var/folders/xr/dg7p5bwj479742q3nl2t23b80000gn/T/prime-agent-501/daemon.sock"), "daemon.sock.bab13329.log");
  assert.equal(cliHelloMisses(stamped("client-errors-after.log", "/s/daemon.sock").split("\n"), "/s/daemon.sock"), 1);
});

test("quantiles are nearest-rank", () => {
  assert.deepEqual(quantiles([3, 1, 2, 10]), [["p50", 2], ["p90", 10], ["p99", 10], ["max", 10]]);
});

test("a round counts only new log lines, fills the call windows from the backfill, and times the hello with no cut", async t => {
  const { dir, logs, service, socket } = await home(t, 30);
  const ctx = context(dir);
  const first = await read(ctx);
  assert.equal(value(first, "harness_latency_timeouts_total"), undefined, "the backfill's cron_list timeout is not counted");
  assert.equal(value(first, "harness_latency_restarts_total", { kind: "supervisor_start" }), 0);
  assert.equal(value(first, "harness_latency_call_samples", { method: "resume", host: LOCAL }), undefined, "the 40 min old resume is out of the window");
  assert.equal(value(first, "harness_latency_call_seconds", { method: "resume", host: "mac", q: "max" }), 0.4);
  assert.equal(value(first, "harness_latency_call_seconds", { method: "attach", host: LOCAL, q: "p50" }), 2.091);
  assert.ok(value(first, "harness_latency_supervisor_cpu_seconds_total", { thread: "main" })! > 0);
  assert.ok(value(first, "harness_latency_supervisor_cpu_seconds_total", { thread: "all" })! >= value(first, "harness_latency_supervisor_cpu_seconds_total", { thread: "main" })!);

  const state = ctx.state.get("latency") as { pending: unknown };
  await until(() => state.pending === null);
  appendFileSync(service, stamped("service-after.log"));
  appendFileSync(join(logs, daemonLogName(socket)), fixture("daemon-after.log"));
  appendFileSync(join(logs, "client-errors.log"), stamped("client-errors-after.log", socket));
  const second = await read(ctx);
  assert.equal(value(second, "harness_latency_hello_samples"), 1);
  assert.ok(value(second, "harness_latency_hello_seconds", { q: "max" })! >= 0.03);
  assert.equal(value(second, "harness_latency_hello_probes_total"), 1);
  assert.equal(value(second, "harness_latency_hello_over_total", { over: "1s" }), 0);
  // A new timeout series goes out at 0 first, so increase() over the next round counts its first events.
  assert.equal(value(second, "harness_latency_timeouts_total", { caller: "pin", method: "list", limit: "30s", host: LOCAL }), 0);
  const third = await read(ctx);
  assert.equal(value(third, "harness_latency_timeouts_total", { caller: "pin", method: "list", limit: "30s", host: LOCAL }), 2);
  assert.equal(value(third, "harness_latency_timeouts_total", { caller: "open", method: "hello", limit: "3s", host: "mac" }), 1);
  assert.equal(value(third, "harness_latency_timeouts_total", { caller: "cli", method: "hello", limit: "2s", host: LOCAL }), 1);
  assert.equal(value(third, "harness_latency_timeouts_total", { caller: "catalog schedules" }), undefined);
  assert.equal(value(second, "harness_latency_restarts_total", { kind: "worker_stop_error" }), 1);
  assert.equal(value(second, "harness_latency_restarts_total", { kind: "supervisor_start" }), 1);
  assert.equal(value(second, "harness_latency_restarts_total", { kind: "worker_crash" }), 0);
  assert.equal(value(second, "harness_latency_call_seconds", { method: "attach", host: LOCAL, q: "max" }), 30, "a timed-out attach counts at its limit");
  assert.equal(value(second, "harness_latency_call_samples", { method: "list", host: LOCAL }), 3);
});

test("a socket that never says hello leaves one probe pending and holds no round", async t => {
  const { dir } = await home(t, null);
  const ctx = context(dir);
  await read(ctx);
  await new Promise(done => setTimeout(done, 50));
  const second = await read(ctx);
  assert.ok(value(second, "harness_latency_hello_pending_seconds")! >= 0.05);
  assert.equal(value(second, "harness_latency_hello_samples"), 0);
  assert.equal(value(second, "harness_latency_hello_seconds", { q: "max" }), undefined);
});

test("prime-calls.jsonl gives each writer's call time per method and box, and counts outcomes for the error rate", async t => {
  const { dir } = await home(t, 30);
  const calls = join(dir, ".prime/agent/browser-chat/prime-calls.jsonl");
  const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  const line = (row: Record<string, unknown>) => JSON.stringify(row) + "\n";
  writeFileSync(calls, line({ ts: at(40), src: "chat", method: "get_state", ms: 9000, outcome: "ok" })
    + line({ ts: at(5), src: "chat", method: "get_state", ms: 20, outcome: "ok" })
    + line({ ts: at(4), src: "chat", method: "get_state", host: "mac", ms: 300, outcome: "ok" })
    + "not json\n");
  const ctx = context(dir);
  const first = await read(ctx);
  assert.equal(value(first, "harness_latency_prime_call_seconds", { src: "chat", method: "get_state", host: LOCAL, q: "max" }), 0.02, "the 40 min old call is out of the window");
  assert.equal(value(first, "harness_latency_prime_call_seconds", { src: "chat", method: "get_state", host: "mac", q: "p50" }), 0.3);
  assert.equal(value(first, "harness_latency_prime_calls_total"), undefined, "the backfill is not counted");

  appendFileSync(calls, line({ ts: at(1), src: "kernel", method: "agent_message.send", target: "x", ms: 30000, outcome: "timeout", error: "Timed out" })
    + line({ ts: at(1), src: "kernel", method: "agent_message.send", ms: 40, outcome: "ok" })
    + line({ ts: at(1), src: "chat", method: "kill", ms: 5, outcome: "refused" })
    + line({ ts: at(1), src: "kernel", method: "agent_message.send", ms: 0, outcome: "unconfirmed", receipt: "unconfirmed", state: "busy" }));
  const second = await read(ctx);
  assert.equal(value(second, "harness_latency_prime_call_seconds", { src: "kernel", method: "agent_message.send", q: "max" }), 30);
  assert.equal(value(second, "harness_latency_prime_call_samples", { src: "kernel", method: "agent_message.send", host: LOCAL }), 2);
  assert.equal(value(second, "harness_latency_prime_calls_total", { src: "kernel", method: "agent_message.send", outcome: "timeout" }), 0, "a new series goes out at 0 first");
  const third = await read(ctx);
  assert.equal(value(third, "harness_latency_prime_calls_total", { src: "kernel", method: "agent_message.send", outcome: "timeout" }), 1);
  assert.equal(value(third, "harness_latency_prime_calls_total", { src: "kernel", method: "agent_message.send", outcome: "ok" }), 1);
  assert.equal(value(third, "harness_latency_prime_calls_total", { src: "chat", method: "kill", host: LOCAL, outcome: "refused" }), 1);
  assert.equal(value(third, "harness_latency_prime_calls_total", { outcome: "unconfirmed" }), undefined, "a receipt is no call");
  assert.equal(value(third, "harness_latency_prime_receipts_total", { src: "kernel", method: "agent_message.send", receipt: "unconfirmed", state: "busy" }), 1);
});

test("primeCalls keeps labels few: an odd method or outcome reads as other or error", () => {
  const [call] = primeCalls([JSON.stringify({ ts: "2026-10-27T01:00:00.000Z", src: "chat", method: "bad method name", ms: 5, outcome: "weird" })], LOCAL);
  assert.deepEqual(call, { at: Date.parse("2026-10-27T01:00:00.000Z"), src: "chat", method: "other", host: LOCAL, s: 0.005, outcome: "error" });
});
