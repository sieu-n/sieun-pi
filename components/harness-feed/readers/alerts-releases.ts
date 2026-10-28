import { createHash } from "node:crypto";
import { open, readdir, readFile, readlink, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { primeUpdateRunning } from "../../../legacy/prime/user-history/src/prime-update.ts";
import type { Context, Sample } from "../otlp.ts";

// alerts-releases: the alert bridge, held resumes and saved job states, board wakes, chat releases and the Updates pane on the chat host, and
// on both boxes whether the Prime daemon and prime-relay answer. Each parse below copies the smallest step of the user-history function it
// names, since those modules use constructor parameter properties that plain node cannot strip.

const MIN = 60_000;
/** user-history src/wakes.ts TICK_MS: the bridge polls, the wakes tick and box-chat-heal runs on it. */
const TICK_MS = 30_000;
/** src/alert-bridge.ts REOPEN_MS. */
const REOPEN_MS = 24 * 3_600_000;
/** src/held-turns.ts RESUME_PENDING_FRESH_MS: two job sweeps (src/chat-checkin.ts JOB_CLEANUP_EVERY_MS, 10 min) and a minute. */
const RESUME_PENDING_FRESH_MS = 2 * 10 * MIN + MIN;
/** components/prime-relay/relay.mjs daemonAnswers: the daemon is up when its socket says daemon_hello within 1.5 s. */
const HELLO_MS = 1500;
/**
 * relay.mjs daemonWorking waits 10 s for the same `list` every 30 s on the Mac. measured: `prime-agent list --json` took 1.2 s wall and 0.7 s
 * CPU on us-metal02 at 14:12Z on 10-27, a 4 MB answer with 118 loaded sessions.
 */
const LIST_MS = 10_000;
/** Linux USER_HZ, the unit of /proc/<pid>/stat starttime. */
const CLOCK_TICKS = 100;
const OTHER = "other";

type Labels = Record<string, string>;
type Unit = Sample["unit"];
const gauge = (name: string, help: string, value: number, labels?: Labels, unit?: Unit): Sample =>
  ({ name, kind: "gauge", help, value, ...(unit ? { unit } : {}), ...(labels ? { labels } : {}) });
const seconds = (ms: number): number => Math.max(0, ms) / 1000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const time = (value: unknown): number | undefined => typeof value === "string" ? num(Date.parse(value)) : undefined;

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; }
}

/** The values of `ctx.state` this reader keeps, under its own key. */
interface Kept {
  names?: { mtimeMs: number; names: Map<string, string>; chatIds: Set<string>; jobChat: Map<string, string> };
  heads: Map<string, string | null>;
  brief?: { release: string; version: string | null };
}
const kept = (ctx: Context): Kept => {
  let value = ctx.state.get("alerts-releases") as Kept | undefined;
  if (!value) ctx.state.set("alerts-releases", value = { heads: new Map() });
  return value;
};

// Chat names ---------------------------------------------------------------------------------------------------------------------------------

/** Session id to chat name, and job session id to its chat id, from browser-chat/chat-jobs.json (the chat writes each job's chat by name and id). */
export function parseChatJobs(value: unknown): { names: Map<string, string>; chatIds: Set<string>; jobChat: Map<string, string> } {
  const names = new Map<string, string>(), latest = new Map<string, number>(), jobChat = new Map<string, string>();
  const jobs = isRecord(value) && isRecord(value.jobs) ? value.jobs : {};
  for (const [job, entry] of Object.entries(jobs)) {
    if (!isRecord(entry) || typeof entry.chatId !== "string") continue;
    jobChat.set(job, entry.chatId);
    const at = num(entry.at) ?? 0;
    if (typeof entry.chat === "string" && at >= (latest.get(entry.chatId) ?? -1)) { latest.set(entry.chatId, at); names.set(entry.chatId, entry.chat); }
  }
  return { names, chatIds: new Set(jobChat.values()), jobChat };
}

/** A session's latest `session_info` name in the first 64 KB of its transcript, the native name the app titles a chat with (sessionTitle). */
async function headName(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const found = [...buffer.subarray(0, bytesRead).toString("utf8").matchAll(/"type":"session_info"[^\n]*?"name":"((?:[^"\\]|\\.)*)"/g)].at(-1)?.[1];
    return found ? JSON.parse(`"${found}"`) as string : null;
  } catch { return null; } finally { await handle?.close(); }
}

interface Chats { name(chat: string): string; chatOf(session: string, root?: string): string }

async function chats(ctx: Context, dir: string): Promise<Chats> {
  const state = kept(ctx);
  const file = join(dir, "chat-jobs.json");
  const mtimeMs = (await stat(file).catch(() => null))?.mtimeMs ?? 0;
  if (state.names?.mtimeMs !== mtimeMs) state.names = { mtimeMs, ...parseChatJobs(await readJson(file)) };
  const { names, chatIds, jobChat } = state.names;
  const listed = await readJson(join(dir, "chats.json"));
  const open = isRecord(listed) && Array.isArray(listed.ids) ? listed.ids.filter((id): id is string => typeof id === "string") : [];
  for (const id of open) {
    chatIds.add(id);
    if (names.has(id)) continue;
    if (!state.heads.has(id)) state.heads.set(id, await headName(join(ctx.home, ".prime/agent/sessions", `${id}.jsonl`)));
    const head = state.heads.get(id);
    if (head) names.set(id, head);
  }
  const name = (chat: string): string => names.get(chat) ?? OTHER;
  const chatOf = (session: string, root?: string): string =>
    chatIds.has(session) ? session : root && chatIds.has(root) ? root : jobChat.get(session) ?? (root ? jobChat.get(root) : undefined) ?? OTHER;
  return { name, chatOf };
}

// Prime daemon and prime-relay (both boxes) -------------------------------------------------------------------------------------------------

/** The daemon socket's first line, or null when it says nothing within HELLO_MS (relay.mjs daemonAnswers). */
export function daemonHello(socketPath: string, waitMs = HELLO_MS): Promise<{ hello: Record<string, unknown>; ms: number } | null> {
  return new Promise(resolve => {
    const started = performance.now();
    const socket = createConnection(socketPath);
    let text = "";
    const done = (value: { hello: Record<string, unknown>; ms: number } | null) => { socket.destroy(); resolve(value); };
    socket.setTimeout(waitMs, () => done(null));
    socket.on("data", chunk => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end < 0 && text.length < 1 << 16) return;
      try {
        const hello: unknown = JSON.parse(end < 0 ? text : text.slice(0, end));
        done(isRecord(hello) ? { hello, ms: performance.now() - started } : null);
      } catch { done(null); }
    });
    socket.once("error", () => done(null));
  });
}

/** When the daemon's supervisor started: `proc:<starttime ticks>` on Linux, `ps:<lstart>` on macOS (daemon_hello supervisorProcessStartId). */
export function supervisorStart(id: unknown, bootMs: number | null): number | undefined {
  if (typeof id !== "string") return undefined;
  const ticks = /^proc:(\d+)$/.exec(id)?.[1];
  if (ticks) return bootMs === null ? undefined : bootMs + Number(ticks) * 1000 / CLOCK_TICKS;
  return id.startsWith("ps:") ? time(id.slice(3)) : undefined;
}

/** Linux boot time from /proc/stat btime; null elsewhere. */
async function bootMs(): Promise<number | null> {
  const text = await readFile("/proc/stat", "utf8").catch(() => "");
  const btime = /^btime (\d+)$/m.exec(text)?.[1];
  return btime ? Number(btime) * 1000 : null;
}

async function prime(ctx: Context): Promise<Sample[]> {
  const relay = await readJson(join(ctx.home, ".config/prime-relay/relay.json"));
  const config = isRecord(relay) ? relay : {};
  const socketPath = typeof config.daemonSocket === "string" ? config.daemonSocket : join(ctx.platform === "darwin" ? tmpdir() : "/tmp", `prime-agent-${userInfo().uid}`, "daemon.sock");
  const [said, boot, relayUp, expected] = await Promise.all([daemonHello(socketPath), bootMs(), relayHealth(config),
    expectedSessions(join(ctx.home, ".prime/agent"), socketPath)]);
  const out: Sample[] = [
    gauge("harness.prime.daemon_up", "1 when the Prime daemon socket answers daemon_hello within 1.5 s, the check prime-relay's /v1/health and the Hosts pane use.", said ? 1 : 0),
    ...expectedSamples(expected),
  ];
  if (relayUp !== null) out.push(gauge("harness.prime.relay_up", "1 when this box's prime-relay answers /v1/health with ok, the check the chat's Hosts pane makes of each box.", relayUp ? 1 : 0));
  if (!said) return out;
  const loaded = await daemonLoaded(socketPath);
  out.push(gauge("harness.prime.list_ok", "1 when the daemon answered its `list` within 10 s with a session list.", loaded === null ? 0 : 1));
  if (loaded !== null) out.push(gauge("harness.prime.sessions_loaded", "Sessions the daemon holds loaded now (`isSessionActive` in its `list`, the rows `prime-agent list --json` marks resident).", loaded));
  out.push(gauge("harness.prime.daemon_hello", "How long the daemon socket took to say daemon_hello.", said.ms / 1000, undefined, "s"));
  const started = supervisorStart(said.hello.supervisorProcessStartId, boot);
  if (started !== undefined) out.push(gauge("harness.prime.daemon_uptime", "How long the Prime daemon supervisor has run.", seconds(ctx.now - started), undefined, "s"));
  if (typeof said.hello.appVersion === "string") out.push(gauge("harness.prime.daemon_version", "1 for the version the Prime daemon reports in daemon_hello.", 1, { version: said.hello.appVersion }));
  return out;
}

/**
 * How many sessions the daemon holds loaded: the rows of one `list` (not `all`, as `prime-agent list --json` asks) with `isSessionActive`, the
 * count resident-before.json took at 08:45Z on 10-27. Null when the daemon did not answer within LIST_MS or answered with an error.
 */
export function daemonLoaded(socketPath: string, waitMs = LIST_MS): Promise<number | null> {
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    const pending: Buffer[] = [];
    let finished = false;
    const done = (value: number | null) => { finished = true; socket.destroy(); resolve(value); };
    const line = (text: string) => {
      let message: unknown;
      try { message = JSON.parse(text); } catch { return; }
      if (!isRecord(message)) return;
      if (message.type === "daemon_hello") {
        socket.write(`${JSON.stringify({ type: "command", id: "harness-feed-list", protocol: message.protocol, clientId: "harness-feed", command: { id: "harness-feed-list", type: "list" } })}\n`);
      } else if (message.id === "harness-feed-list") {
        const rows = message.success === true && isRecord(message.data) && Array.isArray(message.data.sessions) ? message.data.sessions : null;
        done(rows ? rows.filter(row => isRecord(row) && row.isSessionActive === true).length : null);
      }
    };
    socket.setTimeout(waitMs, () => done(null));
    socket.once("error", () => done(null));
    socket.once("end", () => done(null));
    socket.on("data", (chunk: Buffer) => {
      let start = 0;
      for (let end = chunk.indexOf(10); end >= 0 && !finished; end = chunk.indexOf(10, start)) {
        pending.push(chunk.subarray(start, end));
        const text = Buffer.concat(pending).toString("utf8");
        pending.length = 0;
        start = end + 1;
        line(text);
      }
      if (!finished && start < chunk.length) pending.push(chunk.subarray(start));
    });
  });
}

/** Where Prime knows of sessions it should hold loaded, each read from its own files for the daemon on one socket. */
export type ExpectedSource = "recovery" | "manifest" | "worker" | "update";
export type Expected = Record<ExpectedSource, Set<string>>;

const sessionFiles = (sessions: unknown): string[] => Array.isArray(sessions)
  ? sessions.flatMap(session => isRecord(session) && typeof session.sessionFile === "string" ? [session.sessionFile] : [])
  : [];

async function jsonFiles(dir: string): Promise<unknown[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(".json"));
  return Promise.all(names.map(name => readJson(join(dir, name))));
}

/**
 * The session file of a `pending` or `unresolved` recovery record whose session has not run since the record's state was written. A session
 * that ran later was brought back another way, such as by its parent: on 10-28 an `unresolved` record from 10:47Z of a subagent that ran again
 * until 21:35Z kept sessions_expected at 1, and devbox-prime-daemon-empty fired at 21:54Z once idle eviction left 0 sessions loaded.
 */
async function waitingRecovery(record: unknown): Promise<string | null> {
  if (!isRecord(record) || !isRecord(record.state) || (record.state.status !== "pending" && record.state.status !== "unresolved")) return null;
  if (!isRecord(record.session) || typeof record.session.sessionFile !== "string") return null;
  const since = Date.parse(String(record.state.at ?? record.manifestCreatedAt ?? ""));
  const written = await stat(record.session.sessionFile).then(info => info.mtimeMs, () => null);
  return written !== null && Number.isFinite(since) && written > since ? null : record.session.sessionFile;
}

/**
 * The session files Prime should hold loaded on this daemon, by source, read only from its files. Prime keys them by the sha256 of the resolved
 * socket path (config.ts getDaemonUpdateRestartManifestPath, daemon-supervisor.ts descriptorKey).
 * - recovery: `daemon-update-restarts/<hash>.recoveries/*.json` records still `pending` or `unresolved` whose session has not run since
 *   (waitingRecovery), which the supervisor restores on start
 *   (daemon-update-restart-recovery.ts daemonUpdateRestartRecoveryViews). On 10-27 all 188 sessions of the 08:47Z update sat here until 12:56Z.
 * - manifest: `daemon-update-restarts/<hash>.json`, the sessions an update prepare wrote down for its successor to restore.
 * - worker: `daemon-workers/<hash12>/*.json` descriptors in lifecycle `recovering`, workers the supervisor brings back. 39 sat there from
 *   08:48Z on 10-27, each with a dead pid.
 * - update: the planned manifests of an update coordinator that still runs (`update-restarts/<record>.planned.json` beside the record
 *   prime-update.ts primeUpdateRunning finds), 188 sessions from 08:47Z to 10:06Z on 10-27.
 */
export async function expectedSessions(agentDir: string, socketPath: string,
  startId?: (pid: number) => Promise<string | null>): Promise<Expected> {
  const hash = createHash("sha256").update(resolve(socketPath)).digest("hex");
  const restarts = join(agentDir, "daemon-update-restarts");
  const [records, manifest, descriptors, running] = await Promise.all([
    jsonFiles(join(restarts, `${hash}.recoveries`)),
    readJson(join(restarts, `${hash}.json`)),
    jsonFiles(join(agentDir, "daemon-workers", hash.slice(0, 12))),
    primeUpdateRunning(agentDir, socketPath, startId).catch(() => null),
  ]);
  const planned = running ? await readJson(running.file.replace(/\.json$/, ".planned.json")) : undefined;
  const waiting = await Promise.all(records.map(waitingRecovery));
  return {
    recovery: new Set(waiting.flatMap(file => file ? [file] : [])),
    manifest: new Set(isRecord(manifest) ? sessionFiles(manifest.sessions) : []),
    worker: new Set(descriptors.flatMap(descriptor => isRecord(descriptor) && descriptor.lifecycle === "recovering" && typeof descriptor.sessionFile === "string"
      ? [descriptor.sessionFile] : [])),
    update: new Set(isRecord(planned) && isRecord(planned.manifests) ? Object.values(planned.manifests).flatMap(entry => isRecord(entry) ? sessionFiles(entry.sessions) : []) : []),
  };
}

export function expectedSamples(expected: Expected): Sample[] {
  const all = new Set(Object.values(expected).flatMap(files => [...files]));
  return [
    gauge("harness.prime.sessions_expected", "Sessions Prime should hold loaded or restore on this daemon: pending update recoveries, a prepared update manifest, recovering workers and a running update's plan, each session once.", all.size),
    ...(Object.keys(expected) as ExpectedSource[]).map(source =>
      gauge("harness.prime.sessions_expected_from", "Sessions Prime should hold loaded or restore, by the file that names them (alerts-releases.ts expectedSessions).", expected[source].size, { source })),
  ];
}

/** GET /v1/health on this box's relay with its own token; null when the box has no relay config. */
async function relayHealth(config: Record<string, unknown>): Promise<boolean | null> {
  if (typeof config.listen !== "string" || typeof config.port !== "number" || typeof config.tokenFile !== "string") return null;
  const token = (await readFile(config.tokenFile, "utf8").catch(() => "")).trim();
  try {
    const response = await fetch(`http://${config.listen}:${config.port}/v1/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    const body: unknown = await response.json().catch(() => null);
    return response.ok && isRecord(body) && body.ok === true;
  } catch { return false; }
}

// Alert bridge (chat host) ----------------------------------------------------------------------------------------------------------------

interface Rule { chat: string; wokeAt: number; firstWokeAt: number; escalatedAt?: number; resolvedAt?: number; job?: { id: string; at: number } }
interface TriageJob { chat: string; ranAt?: number }
/** browser-chat/alert-bridge.json as src/alert-bridge.ts parseState reads it: v4 keeps the triage jobs apart, v3 kept each job's turn on its rule. */
export interface Bridge { rules: Rule[]; jobs: Record<string, TriageJob>; chats: Record<string, string> }

export function parseBridge(value: unknown): Bridge | null {
  if (!isRecord(value) || !isRecord(value.rules) || ![3, 4, "3", "4"].includes(value.v as number)) return null;
  const rules: Rule[] = [];
  const jobs: Record<string, TriageJob> = isRecord(value.jobs) ? value.jobs as Record<string, TriageJob> : {};
  const chats: Record<string, string> = isRecord(value.chats) ? value.chats as Record<string, string> : {};
  const latest: Record<string, number> = {};
  const v4 = Number(value.v) === 4;
  for (const raw of Object.values(value.rules)) {
    if (!isRecord(raw) || typeof raw.chat !== "string") continue;
    const job = isRecord(raw.job) && typeof raw.job.id === "string" && num(raw.job.at) !== undefined ? { id: raw.job.id, at: raw.job.at as number } : undefined;
    const rule: Rule = { chat: raw.chat, wokeAt: num(raw.wokeAt) ?? 0, firstWokeAt: num(raw.firstWokeAt) ?? num(raw.wokeAt) ?? 0,
      ...(num(raw.escalatedAt) !== undefined ? { escalatedAt: raw.escalatedAt as number } : {}),
      ...(num(raw.resolvedAt) !== undefined ? { resolvedAt: raw.resolvedAt as number } : {}), ...(job ? { job } : {}) };
    rules.push(rule);
    if (v4 || !job || !isRecord(raw.job)) continue;
    const ranAt = num(raw.job.ranAt), was = jobs[job.id]?.ranAt;
    jobs[job.id] = { chat: rule.chat, ...(ranAt !== undefined || was !== undefined ? { ranAt: Math.max(ranAt ?? 0, was ?? 0) } : {}) };
    if (rule.resolvedAt === undefined && job.at > (latest[rule.chat] ?? -1)) { latest[rule.chat] = job.at; chats[rule.chat] = job.id; }
  }
  return { rules, jobs, chats };
}

const firing = (rule: Rule): boolean => rule.resolvedAt === undefined;
/** src/alert-bridge.ts owed: the rule's last fire still waits for a job. */
const owed = (state: Bridge, rule: Rule): boolean => firing(rule) && (rule.job === undefined || rule.job.at < rule.wokeAt ||
  (state.chats[rule.chat] !== rule.job.id && state.jobs[rule.job.id]?.ranAt === undefined));
/** src/alert-bridge.ts held: the rule's job took its last fire and had a model turn end since. */
const held = (state: Bridge, rule: Rule): boolean => {
  const ran = rule.job && state.jobs[rule.job.id]?.ranAt;
  return rule.job !== undefined && rule.job.at >= rule.wokeAt && ran !== undefined && ran >= rule.job.at;
};
/** src/alert-bridge.ts waiting: the rule's job took its last fire within REOPEN_MS and has had no model turn since. */
const waiting = (state: Bridge, rule: Rule, now: number): boolean =>
  rule.job !== undefined && rule.job.at >= rule.wokeAt && !held(state, rule) && now - rule.wokeAt < REOPEN_MS;

/** Per owner chat: what its duty reads (firingRules), whose fire waits for a job, is held by a job turn, or waits on a job's first turn. */
export function bridgeSamples(state: Bridge, now: number, name: (chat: string) => string): Sample[] {
  type Row = { firing: number; owed: number; held: number; waiting: number; escalated: number; fired: number; oldest: number; jobs: number; noTurn: number };
  const rows = new Map<string, Row>();
  const row = (chat: string): Row => {
    const label = name(chat);
    let value = rows.get(label);
    if (!value) rows.set(label, value = { firing: 0, owed: 0, held: 0, waiting: 0, escalated: 0, fired: 0, oldest: 0, jobs: 0, noTurn: 0 });
    return value;
  };
  for (const rule of state.rules) {
    const r = row(rule.chat);
    if (now - rule.wokeAt < 30 * MIN) r.fired++;
    if (!firing(rule)) continue;
    r.firing++;
    if (owed(state, rule)) r.owed++;
    if (held(state, rule)) r.held++;
    if (waiting(state, rule, now)) r.waiting++;
    if (rule.escalatedAt !== undefined && rule.escalatedAt >= rule.wokeAt) r.escalated++;
    r.oldest = Math.max(r.oldest, now - rule.firstWokeAt);
  }
  for (const [id, job] of Object.entries(state.jobs)) {
    if (state.chats[job.chat] !== id) continue;
    const r = row(job.chat);
    r.jobs++;
    if (job.ranAt === undefined) r.noTurn++;
  }
  return [...rows].flatMap(([chat, r]) => [
    gauge("harness.alerts.firing_rules", "Grafana rules firing for the chat, the count its prod alerts duty reads (alert-bridge.ts firingRules).", r.firing, { chat }),
    gauge("harness.alerts.owed_rules", "Firing rules of the chat whose last fire still waits for a triage job (alert-bridge.ts owed).", r.owed, { chat }),
    gauge("harness.alerts.held_rules", "Firing rules of the chat whose triage job had a model turn since it took the fire (alert-bridge.ts held).", r.held, { chat }),
    gauge("harness.alerts.waiting_rules", "Firing rules whose triage job took the fire and has had no model turn yet (alert-bridge.ts waiting).", r.waiting, { chat }),
    gauge("harness.alerts.escalated_rules", "Firing rules the bridge escalated to ops guy since their last fire.", r.escalated, { chat }),
    gauge("harness.alerts.fired_30m", "Rules of the chat that fired, new or back after resolving, in the last 30 min.", r.fired, { chat }),
    gauge("harness.alerts.oldest_firing", "How long the chat's oldest firing rule has fired.", r.oldest / 1000, { chat }, "s"),
    gauge("harness.alerts.triage_jobs", "The chat's current triage job count, 0 or 1.", r.jobs, { chat }),
    gauge("harness.alerts.triage_no_turn", "1 when the chat's current triage job has not had a model turn.", r.noTurn, { chat }),
  ]);
}

/** ~/.cache/virev/alert-bridge-status.json, which the poll worker writes after each poll (src/alert-bridge-health.ts statusOf). */
export function statusSamples(status: unknown, now: number, mtimeMs: number): Sample[] {
  if (!isRecord(status)) return [];
  const health = typeof status.health === "string" ? status.health : "unknown";
  const out = [
    gauge("harness.alerts.bridge_ok", "1 when the alert bridge's last Grafana poll worked and is under 5 min old (alert-bridge-health.ts healthOf).", health === "ok" ? 1 : 0),
    gauge("harness.alerts.bridge_health", "1 for the alert bridge's health word: starting, ok, failing, refused or stale.", 1, { state: health }),
    gauge("harness.alerts.status_age", "How long since the poll worker last wrote its status file; box-chat-heal restarts the chat at 180 s.", seconds(now - (time(status.ts) ?? mtimeMs)), undefined, "s"),
  ];
  const lastOk = time(status.last_ok);
  if (lastOk !== undefined) out.push(gauge("harness.alerts.last_good_poll_age", "How long since the alert bridge last read Grafana's firing list.", seconds(now - lastOk), undefined, "s"));
  const firingCount = num(status.firing_count);
  if (firingCount !== undefined) out.push(gauge("harness.alerts.grafana_firing", "Alerts firing in Grafana at the bridge's last good poll.", firingCount));
  const since = time(status.alert_since);
  out.push(gauge("harness.alerts.bridge_down", "How long the bridge's watchdog has reported it down to ops guy; 0 when it is not.", since === undefined ? 0 : seconds(now - since), undefined, "s"));
  return out;
}

async function alerts(ctx: Context, dir: string, names: Chats): Promise<Sample[]> {
  const statusFile = join(ctx.home, ".cache/virev/alert-bridge-status.json");
  const [status, mtime, state] = await Promise.all([readJson(statusFile), stat(statusFile).catch(() => null), readJson(join(dir, "alert-bridge.json"))]);
  const bridge = parseBridge(state);
  return [...statusSamples(status, ctx.now, mtime?.mtimeMs ?? 0), ...(bridge ? bridgeSamples(bridge, ctx.now, names.name) : [])];
}

// Held resumes and saved job states (chat host) ---------------------------------------------------------------------------------------------

/**
 * browser-chat/resume-pending.json, the cut step owners the last resume pass found (src/held-turns.ts writeResumePending). The chat holds them
 * as working only while the file is under RESUME_PENDING_FRESH_MS old (readHeldTurns), so a stale file counts 0 here too.
 */
export function resumeSamples(value: unknown, now: number, chatOf: (session: string) => string): Sample[] {
  if (!isRecord(value) || num(value.at) === undefined || !Array.isArray(value.runs)) return [];
  const age = now - (value.at as number);
  const fresh = age <= RESUME_PENDING_FRESH_MS;
  const counts = new Map<string, number>();
  if (fresh) for (const run of value.runs) {
    if (!isRecord(run) || typeof run.session !== "string") continue;
    const key = JSON.stringify([chatOf(run.session), typeof run.reason === "string" ? run.reason : "cut"]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return [
    gauge("harness.resume.pass_age", "How long since the chat's resume pass last listed the cut step owners (resume-pending.json at).", seconds(age), undefined, "s"),
    gauge("harness.resume.held", "Cut step owners the chat holds for its own continue, 0 once the list is older than two job sweeps (held-turns.ts readHeldTurns).", total),
    ...[...counts].map(([key, count]) => {
      const [chat, reason] = JSON.parse(key) as [string, string];
      return gauge("harness.resume.held_by", "Cut step owners the chat holds for its continue, by chat and by why the turn was cut.", count, { chat, reason });
    }),
  ];
}

/** browser-chat/job-resumes/<chat>/<child>.json, one saved state per job the cleanup ended while it waited on a step (src/job-resume.ts). */
async function savedJobs(dir: string, now: number, name: (chat: string) => string): Promise<Sample[]> {
  const root = join(dir, "job-resumes");
  const folders = await readdir(root).catch(() => [] as string[]);
  const counts = new Map<string, { all: number; day: number }>();
  await Promise.all(folders.map(async folder => {
    const files = (await readdir(join(root, folder)).catch(() => [] as string[])).filter(file => file.endsWith(".json"));
    const times = await Promise.all(files.map(file => stat(join(root, folder, file)).then(s => s.mtimeMs, () => 0)));
    const count = counts.get(name(folder)) ?? { all: 0, day: 0 };
    count.all += files.length;
    count.day += times.filter(at => now - at < 24 * 60 * MIN).length;
    counts.set(name(folder), count);
  }));
  return [...counts].flatMap(([chat, count]) => [
    gauge("harness.resume.saved_jobs", "Saved states of jobs the chat's cleanup ended while they waited on a board step (job-resumes).", count.all, { chat }),
    gauge("harness.resume.saved_24h", "Jobs the chat's cleanup ended and saved in the last 24 h.", count.day, { chat }),
  ]);
}

// Board wakes (chat host) -------------------------------------------------------------------------------------------------------------------

export interface Wake { session: string; root?: string; kind: "run" | "time"; at?: number; since: number }
/** One wake file, as src/wakes.ts parseWake reads it; null when it is not one. */
export function parseWake(value: unknown): Wake | null {
  if (!isRecord(value) || typeof value.session !== "string" || !isRecord(value.on)) return null;
  const root = typeof value.root === "string" && value.root !== value.session ? { root: value.root } : {};
  const since = num(value.since) ?? 0;
  if (value.on.kind === "run" && num(value.on.run) !== undefined) return { session: value.session, ...root, kind: "run", since };
  if (value.on.kind === "time" && num(value.on.at) !== undefined) return { session: value.session, ...root, kind: "time", at: value.on.at as number, since };
  return null;
}

/**
 * The wakes the chat's ticker has not sent. A time wake more than two ticks past its time is overdue: the ticker sends each due wake at its next
 * tick (TICK_MS). A run wake waits on its CI run, whose state this reader does not read, so it counts as pending only.
 */
export function wakeSamples(wakes: readonly Wake[], now: number, chatOf: (session: string, root?: string) => string, name: (chat: string) => string, tickedMs: number | null): Sample[] {
  const pending = new Map<string, number>(), overdue = new Map<string, number>();
  const oldest = { run: 0, time: 0 };
  let latest = 0;
  for (const wake of wakes) {
    const chat = name(chatOf(wake.session, wake.root));
    const key = JSON.stringify([chat, wake.kind]);
    pending.set(key, (pending.get(key) ?? 0) + 1);
    if (!overdue.has(chat)) overdue.set(chat, 0);
    if (wake.since) oldest[wake.kind] = Math.max(oldest[wake.kind], now - wake.since);
    if (wake.kind === "time" && wake.at! < now - 2 * TICK_MS) {
      overdue.set(chat, overdue.get(chat)! + 1);
      latest = Math.max(latest, now - wake.at!);
    }
  }
  const out = [
    ...[...pending].map(([key, count]) => {
      const [chat, kind] = JSON.parse(key) as [string, string];
      return gauge("harness.wakes.pending", "board.wake waits the chat's ticker has not sent yet, by chat and by kind (run or time).", count, { chat, kind });
    }),
    ...[...overdue].map(([chat, count]) => gauge("harness.wakes.overdue", "Time wakes more than two ticks (60 s) past their time and still not sent.", count, { chat })),
    gauge("harness.wakes.most_late", "How far past its time the latest overdue time wake is; 0 when none is.", latest / 1000, undefined, "s"),
    ...(["run", "time"] as const).map(kind => gauge("harness.wakes.oldest_wait", "How long the oldest pending wake of each kind has waited since board.wake set it.", oldest[kind] / 1000, { kind }, "s")),
  ];
  if (tickedMs !== null) out.push(gauge("harness.wakes.ticker_age", "How long since the wake ticker last beat (wakes/.ticked); board.wake refuses past 120 s.", seconds(now - tickedMs), undefined, "s"));
  return out;
}

async function wakes(ctx: Context, dir: string, names: Chats): Promise<Sample[]> {
  const folder = join(dir, "wakes");
  const files = (await readdir(folder).catch(() => [] as string[])).filter(file => file.endsWith(".json"));
  const [parsed, ticked] = await Promise.all([
    Promise.all(files.map(async file => parseWake(await readJson(join(folder, file))))),
    stat(join(folder, ".ticked")).then(s => s.mtimeMs, () => null),
  ]);
  return wakeSamples(parsed.filter((wake): wake is Wake => wake !== null), ctx.now, names.chatOf, names.name, ticked);
}

// Releases and the Updates pane (chat host) -----------------------------------------------------------------------------------------------

/** Whether `pid` runs: /proc/<pid> on Linux, else signal 0. */
async function alive(pid: number, platform: NodeJS.Platform): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (platform === "linux") return stat(`/proc/${pid}`).then(() => true, () => false);
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** When a Linux process started, from /proc/<pid>/stat field 22 (starttime, in USER_HZ ticks after boot). */
export function procStart(statText: string, bootMs: number): number | undefined {
  const fields = statText.slice(statText.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[19]);
  return Number.isFinite(ticks) ? bootMs + ticks * 1000 / CLOCK_TICKS : undefined;
}

/** src/chat-sdk.ts SdkSync.view: the daemon counts only as x.y.z, the SDK it ships is sdk.json's `shipped` answer for it, else itself. */
export function sdkView(daemonVersion: string | null, client: string | null, saved: unknown): { matched: boolean; auto: boolean; failed: boolean } {
  const record = isRecord(saved) ? saved : {};
  const daemon = daemonVersion && /^\d+\.\d+\.\d+$/.test(daemonVersion) ? daemonVersion : null;
  const shipped = isRecord(record.shipped) && record.shipped.daemon === daemon && typeof record.shipped.sdk === "string" ? record.shipped.sdk : daemon;
  return { matched: shipped === null || shipped === client, auto: record.auto !== false, failed: daemon !== null && record.failedTarget === daemon };
}

async function packageVersion(file: string): Promise<string | null> {
  const value = await readJson(file);
  return isRecord(value) && typeof value.version === "string" ? value.version : null;
}

async function releases(ctx: Context, dir: string, daemonVersion: string | null): Promise<Sample[]> {
  const home = join(ctx.home, ".local/share/sieun-pi-chat");
  const names = await readdir(home).catch(() => null);
  if (!names) return [];
  const [current, started, lock, instance, boot] = await Promise.all([
    readlink(join(home, "current")).catch(() => null), readJson(join(home, "started.json")), readJson(join(home, "release.lock")),
    readJson(join(dir, "instance.json")), bootMs()]);
  const live = isRecord(started) && typeof started.id === "string" ? started.id : null;
  const out: Sample[] = [];
  const info = "1 for the release the chat last started on (role live) and the one current points at (role current).";
  if (live) out.push(gauge("harness.release.info", info, 1, { release: live, role: "live" }));
  if (current) out.push(gauge("harness.release.info", info, 1, { release: current, role: "current" }));
  out.push(gauge("harness.release.restart_pending", "1 when current points at a release the chat has not restarted onto, or restart.owed is left.",
    (current !== null && current !== live) || names.includes("restart.owed") ? 1 : 0));
  const builtAt = live ? time((await readJson(join(home, live, "release.json")) as Record<string, unknown> | undefined)?.builtAt) : undefined;
  const startedAt = isRecord(started) ? time(started.at) : undefined;
  if (builtAt !== undefined) out.push(gauge("harness.release.age", "How long ago the live release was built.", seconds(ctx.now - builtAt), undefined, "s"));
  if (builtAt !== undefined && startedAt !== undefined)
    out.push(gauge("harness.release.build_to_restart", "Time from the live release's build to the restart that put it live (release.json builtAt to started.json at).", seconds(startedAt - builtAt), undefined, "s"));
  const pid = isRecord(instance) ? num(instance.pid) : undefined;
  if (pid !== undefined && boot !== null) {
    const start = procStart(await readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""), boot);
    if (start !== undefined) out.push(gauge("harness.release.chat_uptime", "How long the live chat process (instance.json pid) has run.", seconds(ctx.now - start), undefined, "s"));
  }
  const lockPid = isRecord(lock) ? num(lock.pid) : undefined;
  const lockHeld = lockPid !== undefined && await alive(lockPid, ctx.platform);
  out.push(gauge("harness.release.lock_held", "1 while a release-chat.mjs run holds release.lock.", lockHeld ? 1 : 0));
  const lockAt = isRecord(lock) ? time(lock.startedAt) : undefined;
  out.push(gauge("harness.release.lock_age", "How long the run holding release.lock has held it; 0 when none does.", lockHeld && lockAt !== undefined ? seconds(ctx.now - lockAt) : 0, undefined, "s"));
  const pidOf = (pattern: RegExp) => names.flatMap(name => { const found = pattern.exec(name)?.[1]; return found ? [Number(found)] : []; });
  const liveCount = async (pids: number[]) => (await Promise.all(pids.map(id => alive(id, ctx.platform)))).filter(Boolean).length;
  const [waiting, building] = await Promise.all([liveCount(pidOf(/^release\.lock\.(\d+)$/)), liveCount(pidOf(/^\.building-release-[0-9a-f]+-(\d+)$/))]);
  out.push(gauge("harness.release.waiting", "release-chat.mjs runs waiting for release.lock (live release.lock.<pid> drafts).", waiting),
    gauge("harness.release.building", "Release folders being built now (live .building-release-<sha>-<pid> folders).", building));
  const client = live ? await packageVersion(join(home, live, "legacy/prime/user-history/node_modules/prime-agent/package.json"))
    ?? await packageVersion(join(home, live, "node_modules/prime-agent/package.json")) : null;
  if (client) out.push(gauge("harness.release.client_version", "1 for the prime-agent SDK version the live release loads, the Updates pane's client.", 1, { version: client }));
  const sdk = sdkView(daemonVersion, client, await readJson(join(dir, "sdk.json")));
  out.push(gauge("harness.release.sdk_matched", "1 when the Updates pane reads Matched: the chat's SDK is the one the daemon ships, or the daemon gave no x.y.z version.", sdk.matched ? 1 : 0),
    gauge("harness.release.sdk_auto", "1 when the Updates pane's automatic SDK update is on (sdk.json auto).", sdk.auto ? 1 : 0),
    gauge("harness.release.sdk_update_failed", "1 when the last SDK update to the daemon's version failed (sdk.json failedTarget).", sdk.failed ? 1 : 0));
  return out;
}

// Chat rules, Settings > Updates (chat host) -------------------------------------------------------------------------------------------------

/** The brief the live release runs (src/chat-brief.ts chatBrief), imported from that release's own source once per release. */
async function currentBrief(ctx: Context, live: string): Promise<string | null> {
  const state = kept(ctx);
  if (state.brief?.release === live) return state.brief.version;
  const file = join(ctx.home, ".local/share/sieun-pi-chat", live, "legacy/prime/user-history/src/chat-brief.ts");
  const version = await import(pathToFileURL(file).href).then((module: { chatBrief?: () => { version: string } }) => module.chatBrief?.().version ?? null, () => null);
  state.brief = { release: live, version };
  return version;
}

/**
 * Settings > Updates, Chat rules (src/chats.ts Chats.briefs): each open chat's last loaded brief version from extension-loads.json `briefs`
 * against the live release's, so `behind` is the pane's count of chats not on the current brief. A chat with no recorded version counts behind.
 */
export function briefSamples(current: string, chatIds: readonly string[], loads: unknown, name: (chat: string) => string): Sample[] {
  const loaded = isRecord(loads) && isRecord(loads.briefs) ? loads.briefs : {};
  const rows = chatIds.map(id => ({ chat: name(id), current: loaded[id] === current ? 1 : 0 }));
  return [
    gauge("harness.release.brief_current", "1 for the chat brief version the live release runs.", 1, { version: current }),
    gauge("harness.release.brief_behind", "Open chats whose last loaded brief is not the live release's, the Updates pane's chats not on it yet.", rows.filter(row => !row.current).length),
    gauge("harness.release.brief_chats", "Open chats the Updates pane lists under Chat rules.", rows.length),
    ...rows.map(row => gauge("harness.release.brief_up_to_date", "1 when the chat last loaded the live release's brief.", row.current, { chat: row.chat })),
  ];
}

async function briefs(ctx: Context, dir: string, names: Chats): Promise<Sample[]> {
  const [listed, started] = await Promise.all([readJson(join(dir, "chats.json")), readJson(join(ctx.home, ".local/share/sieun-pi-chat/started.json"))]);
  const live = isRecord(started) && typeof started.id === "string" ? started.id : null;
  const current = live ? await currentBrief(ctx, live) : null;
  if (!current || !isRecord(listed) || !Array.isArray(listed.ids)) return [];
  const ids = listed.ids.filter((id): id is string => typeof id === "string");
  return briefSamples(current, ids, await readJson(join(dir, "extension-loads.json")), names.name);
}

// Settings > Tools and skills, live checks (chat host) ---------------------------------------------------------------------------------------

/**
 * browser-chat/tool-checks.json, the view of the chat's last live tool check run (src/chat-tools.ts toolChecks, TOOL_CHECKS_FILE). The chat runs
 * the checks only when the Tools page asks, so the age grows while nobody opens it. `host` names the checked box, since Alloy's `box` names the
 * reporting one.
 */
export function toolSamples(view: unknown, now: number): Sample[] {
  if (!isRecord(view) || !Array.isArray(view.hosts)) return [];
  const out: Sample[] = [];
  const checkedAt = num(view.checkedAt);
  if (checkedAt !== undefined) out.push(gauge("harness.tools.check_age", "How long since the chat last ran the Tools page's live checks.", seconds(now - checkedAt), undefined, "s"));
  for (const card of view.hosts) {
    if (!isRecord(card) || typeof card.name !== "string" || !Array.isArray(card.tools)) continue;
    const host = card.name;
    out.push(gauge("harness.tools.host_unreachable", "1 when the box did not answer the last live tool checks.", card.state === "unreachable" ? 1 : 0, { host }));
    for (const row of card.tools) {
      if (!isRecord(row) || row.used !== true || typeof row.tool !== "string" || !Array.isArray(row.checks)) continue;
      const checks = row.checks.filter(isRecord);
      const tool = row.tool;
      out.push(gauge("harness.tools.checks", "Live checks of the tool on the box at the last run.", checks.length, { host, tool }),
        gauge("harness.tools.failing", "Live checks of the tool on the box that failed at the last run.", checks.filter(check => check.status === "fail").length, { host, tool }));
      for (const check of checks) {
        if (typeof check.id !== "string" || num(check.ms) === undefined) continue;
        out.push(gauge("harness.tools.check_duration", "How long each live check took at the last run.", (check.ms as number) / 1000, { host, tool, check: check.id }, "s"));
      }
    }
  }
  return out;
}

// Round ---------------------------------------------------------------------------------------------------------------------------------------

export async function read(ctx: Context): Promise<Sample[]> {
  const boxSamples = await prime(ctx);
  if (!ctx.chatHost) return boxSamples;
  const dir = join(ctx.home, ".prime/agent/browser-chat");
  const names = await chats(ctx, dir);
  const daemonVersion = boxSamples.find(sample => sample.name === "harness.prime.daemon_version")?.labels?.version ?? null;
  const parts = await Promise.all([
    alerts(ctx, dir, names),
    readJson(join(dir, "resume-pending.json")).then(value => resumeSamples(value, ctx.now, session => names.name(names.chatOf(session)))),
    savedJobs(dir, ctx.now, names.name),
    wakes(ctx, dir, names),
    releases(ctx, dir, daemonVersion),
    briefs(ctx, dir, names),
    readJson(join(dir, "tool-checks.json")).then(view => toolSamples(view, ctx.now)),
  ]);
  return [...boxSamples, ...parts.flat()];
}
