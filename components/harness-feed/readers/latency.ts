import { open, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { Context, Sample } from "../otlp.ts";

/*
 * latency: how fast the box's Prime daemon answers, on every box (the Mac too), for the owner's question of 10-22 "is prime-agent
 * durable/idempotent/... behave consistently when on load & responding super slow? i regularly get the 30000ms time limit".
 *
 * 1. The hello: one probe a round connects to the daemon socket and times its daemon_hello line, as relay.mjs daemonAnswers and sieun-pi's
 *    daemon-list.ts openDaemon do, but with no cut, so a 9 s hello reads 9 s. The probe is never awaited by the round: a round starts one when
 *    none is in flight, and reports every probe that settled since, so a supervisor that never says hello shows as a growing pending age and
 *    holds no other reader. readers/alerts-releases.ts cuts its probe at 1.5 s, so its harness_prime_daemon_hello_seconds misses every slow one.
 * 2. Daemon call times by method and the timeouts by caller come from the chat service's log (browser-chat/service.log, chat host only),
 *    because the supervisor logs no call times. The chat logs the attach of each open, each worker start and each full list with its time,
 *    and every `Timed out after <ms>ms waiting for the Prime Agent daemon ...` error with the line's own prefix, which names the caller.
 *    Prime's DaemonClient raises that error (daemon-client.ts armPendingRequestTimeout, DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 30_000, and
 *    waitForHello for the handshake). The prime-agent CLI's own 2 s hello misses go to logs/client-errors.log on each box.
 * 3. The supervisor's CPU: its main thread and the whole process, from /proc/<pid>/task/<pid>/stat on Linux and `ps -M` on macOS, as
 *    cumulative seconds. ~/work/daemon-hello-latency/REPORT.md found the main thread runnable for the whole of every 7 to 10 s hello stall.
 * 4. Supervisor and worker starts and stops from the live supervisor log, logs/daemon.sock.<sha256(socket)[:8]>.log.
 * Box load is not sent again: harness_host_load (Linux, readers/memory-mac.ts), devbox_load1 (the Mac's Alloy) and harness_host_cores have it.
 */

const WINDOW_MS = 30 * 60_000;
/** The first read of service.log starts this far back, so the call windows fill at once; its timeouts are not counted, counters start at 0. */
const SERVICE_BACKFILL_BYTES = 2 * 1024 * 1024;
/** Linux USER_HZ, the unit of /proc/<pid>/stat utime and stime. */
const CLOCK_TICKS = 100;
/** The hello marks: 1 s the parent's brief, 3 s DaemonClient.waitForHello's default, 30 s sieun-pi's wait (commits 44ac474c, 1f609e8e). */
export const HELLO_MARKS = [1, 3, 30] as const;
const QUANTILES = [["p50", 0.5], ["p90", 0.9], ["p99", 0.99], ["max", 1]] as const;

type Labels = Record<string, string>;
const gauge = (name: string, help: string, value: number, labels?: Labels, unit?: Sample["unit"]): Sample =>
  ({ name, kind: "gauge", help, value, ...(unit ? { unit } : {}), ...(labels ? { labels } : {}) });
const counter = (name: string, help: string, value: number, labels?: Labels, unit?: Sample["unit"]): Sample =>
  ({ name, kind: "counter", help, value, ...(unit ? { unit } : {}), ...(labels ? { labels } : {}) });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type Tail = { offset: number; rest: Buffer };

/**
 * The whole lines appended to `file` since `tail`, and the tail to keep (copied from readers/chat-health.ts readNew, whose import tree is the
 * chat app's). A first read starts `firstBytes` before the end and drops the line it cuts; a file that shrank is read again from its start.
 */
async function readNew(file: string, tail: Tail | undefined, firstBytes: number): Promise<{ lines: string[]; tail: Tail } | null> {
  let handle;
  try { handle = await open(file, "r"); } catch { return null; }
  try {
    const { size } = await handle.stat();
    const from = tail && tail.offset <= size ? tail.offset : tail ? 0 : Math.max(0, size - firstBytes);
    const rest = tail && tail.offset <= size ? tail.rest : Buffer.alloc(0);
    const bytes = Buffer.alloc(size - from);
    if (bytes.length) await handle.read(bytes, 0, bytes.length, from);
    const all = rest.length ? Buffer.concat([rest, bytes]) : bytes;
    const end = all.lastIndexOf(10);
    if (end < 0) return { lines: [], tail: { offset: size, rest: all } };
    const lines = all.subarray(0, end).toString("utf8").split("\n");
    if (!tail && from > 0) lines.shift();
    return { lines: lines.filter(line => line.length > 0), tail: { offset: size, rest: Buffer.from(all.subarray(end + 1)) } };
  } finally { await handle.close(); }
}
type Probe = { ok: true; ms: number } | { ok: false; reason: string };
/** A timed daemon call the chat service logged: when it ended, how long it took, and the box whose daemon answered. */
export interface Call { at: number; method: string; host: string; s: number }
/** A daemon call that ran into its caller's limit. */
export interface Timeout { caller: string; method: string; limit: string; host: string }

interface State {
  pending: { at: number } | null;
  hellos: { at: number; s: number }[];
  probes: number;
  over: Map<number, number>;
  failed: Map<string, number>;
  tails: Map<string, Tail>;
  calls: Call[];
  timeouts: Map<string, number>;
  restarts: Map<string, number>;
  /** Counter series already sent; a new one goes out at 0 for one round first, so increase() sees its first events. */
  sent: Set<string>;
}

const kept = (ctx: Context): State => {
  let state = ctx.state.get("latency") as State | undefined;
  if (!state) ctx.state.set("latency", state = { pending: null, hellos: [], probes: 0, over: new Map(), failed: new Map(), tails: new Map(), calls: [], timeouts: new Map(),
    restarts: new Map(LIFECYCLE.map(([, kind]) => [kind, 0])), sent: new Set() });
  return state;
};
const bump = (map: Map<string, number>, key: string, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

/** Nearest-rank quantiles of `values`. */
export function quantiles(values: readonly number[]): [string, number][] {
  const sorted = [...values].sort((a, b) => a - b);
  return QUANTILES.map(([q, p]) => [q, sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!]);
}

// The hello probe ----------------------------------------------------------------------------------------------------------------------------

/** Connects to `socketPath` and times its first line, the daemon_hello, with no cut; a socket that never answers leaves it pending. */
export function probeHello(socketPath: string): Promise<Probe> {
  return new Promise(done => {
    const started = performance.now();
    const socket = createConnection(socketPath);
    let text = "", settled = false;
    const finish = (probe: Probe) => { if (settled) return; settled = true; socket.destroy(); done(probe); };
    socket.on("data", chunk => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end < 0) return;
      let hello: unknown;
      try { hello = JSON.parse(text.slice(0, end)); } catch { hello = null; }
      finish(isRecord(hello) && hello.type === "daemon_hello" ? { ok: true, ms: performance.now() - started } : { ok: false, reason: "not_hello" });
    });
    socket.on("error", (error: NodeJS.ErrnoException) => finish({ ok: false, reason: error.code === "ENOENT" ? "no_socket" : error.code === "ECONNREFUSED" ? "refused" : "error" }));
    socket.on("close", () => finish({ ok: false, reason: "closed" }));
  });
}

function startProbe(state: State, socketPath: string): void {
  if (state.pending) return;
  state.pending = { at: Date.now() };
  void probeHello(socketPath).then(probe => {
    state.pending = null;
    if (!probe.ok) { bump(state.failed, probe.reason); return; }
    state.probes++;
    state.hellos.push({ at: Date.now(), s: probe.ms / 1000 });
    for (const mark of HELLO_MARKS) if (probe.ms > mark * 1000) state.over.set(mark, (state.over.get(mark) ?? 0) + 1);
  });
}

// service.log: call times and timeouts ------------------------------------------------------------------------------------------------------

const STAMPED = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;
/** src/chat-threads.ts `finish`: `open <id8>[ on <box>] live|saved <n> messages: <marks>, total <ms>ms`, written to stderr with no stamp. */
const OPEN = /^open [0-9a-f]{8}(?: on ([\w.-]+))? (?:live|saved) \d+ messages: (.*), total \d+ms$/;
const ATTACH = /(?:^|, )attach (\d+)ms/;
/** src/daemon-worker-start.ts: `daemon create|resume|reload|spare <what>: answered|refused in <s> s`, stamped when the start began. */
const WORKER_START = /^daemon (create|resume|reload|spare) (.+?): (?:answered|refused) in ([\d.]+) s\b/;
const WORKER_NO_ANSWER = /^daemon (create|resume|reload|spare) (.+?): no answer after ([\d.]+) s: /;
const START_ON = /^[0-9a-f]{8} on ([\w.-]+)$/;
/** src/session-peer.ts: `copy <box>: full list answered in <s> s, <n> rows`. */
const FULL_LIST = /^(?:catalog|hosts): copy ([\w.-]+): full list answered in ([\d.]+) s\b/;
/** Prime's DaemonClient errors (daemon-client.ts): a response or handshake past the caller's limit, and the supervisor's own worker wait. */
const TIMED_OUT = /Timed out after (\d+)ms waiting for the Prime Agent daemon (?:response to "(\w+)"|(handshake))|Timed out waiting for daemon worker response to (\w+)/g;
const SOCKET = /Socket: \S*\/hosts\/([\w.-]+)\.sock\b/;
const NAMED_BOX = /^(?:open|outbox) [0-9a-f]{8} on ([\w.-]+)[: ]|The Prime Agent daemon on ([\w.-]+) is not reachable/;
/** Methods the call windows time; a timeout of one of them goes into its window at its limit, since the call took at least that long. */
const TIMED_METHODS = new Set(["attach", "create", "resume", "reload", "spare", "list"]);

/** The caller of a service.log line, from the prefix its writer gives it in user-history src (one fixed name each, so labels stay few). */
const CALLERS: readonly [RegExp, string][] = [
  [/^open [0-9a-f]{8}\b/, "open"], [/^job [0-9a-f]{8}: wake\b/, "job wake"], [/^job [0-9a-f]{8}: reload\b/, "job reload"],
  [/^job [0-9a-f]{8}: interrupted\b/, "job resume"], [/^job /, "job"], [/^outbox /, "outbox"], [/^hosts: /, "hosts copy"],
  [/^catalog schedules: /, "catalog schedules"], [/^catalog: /, "catalog copy"], [/^idle unload: /, "idle unload"], [/^wakes?:? /, "wakes"],
  [/^pin /, "pin"], [/^duty jobs: /, "duty jobs"], [/^duty archive queue: /, "duty archive"], [/^duty /, "duty"], [/^daemon gate: /, "daemon gate"],
  [/^daemon (?:create|resume|reload|spare) /, "worker start"], [/^(?:chats: interrupted jobs|resume): /, "resume pass"], [/^slack /, "slack"],
  [/^alerts: /, "alerts"], [/^mac usable watch: /, "usable watch"], [/^chat [0-9a-f]{8}: /, "chat"], [/^briefs: /, "briefs"],
  [/^thread [0-9a-f]{8}: /, "thread"], [/^queue park: /, "queue park"],
];
export const callerOf = (text: string): string => CALLERS.find(([pattern]) => pattern.test(text))?.[1] ?? "other";

const limitLabel = (ms: number): string => `${ms / 1000}s`;
const hostIn = (text: string, local: string): string => {
  const named = NAMED_BOX.exec(text);
  return SOCKET.exec(text)?.[1] ?? named?.[1] ?? named?.[2] ?? local;
};

/**
 * The timed calls and the timeouts in chat service log lines. An unstamped line, such as an open's, takes the last stamped line's time, as
 * daemon-faults.ts reads it; a worker start's stamp is its start, so its call ends `s` later.
 */
export function serviceEvents(lines: readonly string[], local: string): { calls: Call[]; timeouts: Timeout[] } {
  const calls: Call[] = [], timeouts: Timeout[] = [];
  let at = NaN;
  for (const raw of lines) {
    const stamped = STAMPED.exec(raw);
    if (stamped) at = Date.parse(stamped[1]!);
    const text = stamped ? stamped[2]! : raw;
    let found: RegExpExecArray | null;
    if ((found = OPEN.exec(text))) {
      const attach = ATTACH.exec(found[2]!);
      if (attach && Number.isFinite(at)) calls.push({ at, method: "attach", host: found[1] ?? local, s: Number(attach[1]) / 1000 });
    } else if ((found = WORKER_START.exec(text) ?? WORKER_NO_ANSWER.exec(text))) {
      const s = Number(found[3]);
      const host = found[1] === "spare" ? found[2]!.split(" ")[0]! : START_ON.exec(found[2]!)?.[1] ?? local;
      if (Number.isFinite(at)) calls.push({ at: at + s * 1000, method: found[1]!, host, s });
    } else if ((found = FULL_LIST.exec(text))) {
      if (Number.isFinite(at)) calls.push({ at, method: "list", host: found[1]!, s: Number(found[2]) });
    }
    if (!text.includes("Timed out")) continue;
    const caller = callerOf(text), host = hostIn(text, local);
    for (const match of text.matchAll(TIMED_OUT)) {
      const method = match[2] ?? (match[3] ? "hello" : match[4]!);
      const limit = match[1] ? limitLabel(Number(match[1])) : "worker";
      timeouts.push({ caller, method, limit, host });
      if (match[2] && TIMED_METHODS.has(method) && Number.isFinite(at)) calls.push({ at, method, host, s: Number(match[1]) / 1000 });
    }
  }
  return { calls, timeouts };
}

/** prime-agent's cli/daemon-launch.ts probeDaemonVersion: the CLI waited 2 s for the box's own daemon's hello and got none. */
export function cliHelloMisses(lines: readonly string[], socketPath: string): number {
  const miss = `daemon-launch: running daemon on ${socketPath} sent no recognizable hello`;
  return lines.filter(line => line.includes(miss)).length;
}

// The supervisor log: starts and stops ------------------------------------------------------------------------------------------------------

/** Supervisor and worker lifecycle lines of the daemon log, by kind (daemon-supervisor.ts and the worker's own stderr). */
const LIFECYCLE: readonly [RegExp, string][] = [
  [/^\[\S+Z\] supervisor: Prime Agent daemon supervisor \S+ listening on /, "supervisor_start"],
  [/^\[\S+Z\] supervisor: Session worker \w+ stderr: Prime Agent daemon listening on /, "worker_start"],
  [/^\[\S+Z\] supervisor: Session worker \w+ stderr: shutting down \(exit 0\)/, "worker_stop"],
  [/^\[\S+Z\] supervisor: Session worker \w+ stderr: shutting down \(exit [1-9]\d*\)/, "worker_stop_error"],
  [/^\[\S+Z\] supervisor: Session worker \w+ stderr: (?:unhandled rejection|uncaught exception): /, "worker_crash"],
  [/^\[\S+Z\] supervisor: Evicted idle worker /, "worker_evicted"],
  [/^\[\S+Z\] supervisor: Finalized timed-out stop for worker /, "worker_stop_timed_out"],
  [/^\[\S+Z\] supervisor: Could not adopt worker /, "worker_adopt_failed"],
];

export function lifecycleEvents(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const kind = LIFECYCLE.find(([pattern]) => pattern.test(line))?.[1];
    if (kind) bump(counts, kind);
  }
  return counts;
}

// Supervisor CPU ----------------------------------------------------------------------------------------------------------------------------

/** utime + stime in seconds from a /proc stat line (fields 14 and 15, counted after the `)` that ends the command name). */
export function statCpu(text: string): number | undefined {
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[11]) + Number(fields[12]);
  return Number.isFinite(ticks) ? ticks / CLOCK_TICKS : undefined;
}

/** `[[h:]m]m:ss.cc` as ps prints CPU time. */
const psTime = (text: string): number => text.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);

/** The main thread's and every thread's CPU seconds from `ps -M -p <pid>`: the first thread row is the main thread; STIME and UTIME end each row before the command. */
export function psThreadsCpu(text: string): { main: number; all: number } | undefined {
  const rows = text.split("\n").slice(1).filter(row => row.trim());
  const times = rows.map(row => {
    const found = /\s(\d+(?::\d+)*\.\d+)\s+(\d+(?::\d+)*\.\d+)(?:\s|$)/.exec(row);
    return found ? psTime(found[1]!) + psTime(found[2]!) : NaN;
  }).filter(Number.isFinite);
  return times.length ? { main: times[0]!, all: times.reduce((a, b) => a + b, 0) } : undefined;
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise(done => execFile(file, args, { encoding: "utf8" }, (error, stdout) => done(error ? "" : stdout)));

async function supervisorCpu(ctx: Context, pid: number): Promise<{ main: number; all: number } | undefined> {
  if (ctx.platform === "darwin") return psThreadsCpu(await run("/bin/ps", ["-M", "-p", String(pid)]));
  const [main, all] = await Promise.all([readFile(`/proc/${pid}/task/${pid}/stat`, "utf8").catch(() => ""), readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")]);
  const m = main ? statCpu(main) : undefined, a = all ? statCpu(all) : undefined;
  return m !== undefined && a !== undefined ? { main: m, all: a } : undefined;
}

// The round ---------------------------------------------------------------------------------------------------------------------------------

async function socketOf(ctx: Context): Promise<string> {
  let config: unknown;
  try { config = JSON.parse(await readFile(join(ctx.home, ".config/prime-relay/relay.json"), "utf8")); } catch { config = undefined; }
  const named = isRecord(config) && typeof config.daemonSocket === "string" ? config.daemonSocket : undefined;
  return named ?? join(ctx.platform === "darwin" ? tmpdir() : "/tmp", `prime-agent-${userInfo().uid}`, "daemon.sock");
}

/** prime-agent config.ts getDaemonLogPath: `<socket basename>.<sha256 of the resolved socket path, 8 hex>.log` in the logs folder. */
export const daemonLogName = (socketPath: string): string => {
  const normalized = resolve(socketPath);
  return `${normalized.slice(normalized.lastIndexOf("/") + 1)}.${createHash("sha256").update(normalized).digest("hex").slice(0, 8)}.log`;
};

async function newLines(state: State, file: string, firstBytes: number): Promise<{ lines: string[]; first: boolean }> {
  const known = state.tails.get(file);
  const read = await readNew(file, known, firstBytes);
  if (!read) return { lines: [], first: !known };
  state.tails.set(file, read.tail);
  return { lines: read.lines, first: !known };
}

export async function read(ctx: Context): Promise<Sample[]> {
  const state = kept(ctx);
  const socketPath = await socketOf(ctx);
  startProbe(state, socketPath);
  const logs = join(ctx.home, ".prime/agent/logs");
  const now = ctx.now;

  const owner = await readFile(`${socketPath}.lock/owner.json`, "utf8").then(text => JSON.parse(text) as unknown, () => undefined);
  const pid = isRecord(owner) && typeof owner.pid === "number" ? owner.pid : undefined;
  const [cpu, daemonLog, clientLog, serviceLog] = await Promise.all([
    pid ? supervisorCpu(ctx, pid) : undefined,
    newLines(state, join(logs, daemonLogName(socketPath)), 0),
    newLines(state, join(logs, "client-errors.log"), 0),
    ctx.chatHost ? newLines(state, join(ctx.home, ".prime/agent/browser-chat/service.log"), SERVICE_BACKFILL_BYTES) : undefined,
  ]);

  for (const [kind, count] of lifecycleEvents(daemonLog.lines)) bump(state.restarts, kind, count);
  const misses = cliHelloMisses(clientLog.lines, socketPath);
  if (misses) bump(state.timeouts, JSON.stringify({ caller: "cli", method: "hello", limit: "2s", host: ctx.host }), misses);
  if (serviceLog) {
    const events = serviceEvents(serviceLog.lines, ctx.host);
    state.calls.push(...events.calls);
    if (!serviceLog.first) for (const timeout of events.timeouts) bump(state.timeouts, JSON.stringify(timeout));
  }
  state.calls = state.calls.filter(call => call.at >= now - WINDOW_MS);
  state.hellos = state.hellos.filter(hello => hello.at >= Date.now() - WINDOW_MS);

  const out: Sample[] = [];
  const helloHelp = "How long the daemon socket took to say daemon_hello over the last 30 min, from one probe a round with no cut, by quantile.";
  for (const [q, value] of state.hellos.length ? quantiles(state.hellos.map(hello => hello.s)) : []) out.push(gauge("harness.latency.hello", helloHelp, value, { q }, "s"));
  out.push(gauge("harness.latency.hello_samples", "Hello probes that got their hello in the last 30 min.", state.hellos.length),
    gauge("harness.latency.hello_pending", "How long the hello probe still in flight has waited; 0 when none is.", state.pending ? (Date.now() - state.pending.at) / 1000 : 0, undefined, "s"),
    counter("harness.latency.hello_probes", "Hello probes that got their hello.", state.probes));
  for (const mark of HELLO_MARKS)
    out.push(counter("harness.latency.hello_over", "Hello probes whose hello took longer than the mark: 1 s the target, 3 s the CLI's fixed wait, 30 s sieun-pi's wait.", state.over.get(mark) ?? 0, { over: `${mark}s` }));
  const shown = (key: string, value: number): number => state.sent.has(key) ? value : (state.sent.add(key), 0);
  for (const [reason, value] of state.failed)
    out.push(counter("harness.latency.hello_failed", "Hello probes that got no hello, by why: no_socket, refused, closed, not_hello or error.", shown(`failed ${reason}`, value), { reason }));

  const byMethod = new Map<string, number[]>();
  for (const call of state.calls) {
    const key = JSON.stringify({ method: call.method, host: call.host });
    byMethod.set(key, [...byMethod.get(key) ?? [], call.s]);
  }
  for (const [key, values] of byMethod) {
    const labels = JSON.parse(key) as Labels;
    for (const [q, value] of quantiles(values))
      out.push(gauge("harness.latency.call", "Daemon call time over the last 30 min by method and the box whose daemon answered, from the chat service's log; a timed-out call counts at its limit.", value, { ...labels, q }, "s"));
    out.push(gauge("harness.latency.call_samples", "Daemon calls the chat service logged with a time in the last 30 min, by method and box.", values.length, labels));
  }
  for (const [key, value] of state.timeouts)
    out.push(counter("harness.latency.timeouts", "Daemon calls that ran into their caller's limit (`Timed out after <ms>ms waiting for the Prime Agent daemon`), by caller, method, limit and box.", shown(key, value), JSON.parse(key) as Labels));
  for (const [kind, value] of state.restarts)
    out.push(counter("harness.latency.restarts", "Supervisor starts and worker starts, stops, crashes, evictions and failed adoptions in the supervisor log.", value, { kind }));
  if (cpu) out.push(counter("harness.latency.supervisor_cpu", "CPU seconds the Prime supervisor has used since it started: its main thread, and all its threads.", cpu.main, { thread: "main" }, "s"),
    counter("harness.latency.supervisor_cpu", "CPU seconds the Prime supervisor has used since it started: its main thread, and all its threads.", cpu.all, { thread: "all" }, "s"));
  return out;
}
