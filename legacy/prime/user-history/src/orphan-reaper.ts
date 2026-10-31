import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { jobLive, livePaths } from "./job-live.ts";

/**
 * The d2 orphan reaper on us-metal02: it lists the processes whose owning Prime session ended over ENDED_FOR_MS ago and stops them. On 10-28 a
 * Mac job (01a183f7) started a headful Chrome driver on this box over ssh, and it ran 2 days after the job ended, polling staging and making
 * 2,320 Convex failures, until a home report job killed it at about 06:27Z on 10-31. The chat service's job end (job-leftovers.ts) stops strays
 * only when a job is deleted or archived, and only those whose env names its session, so a finished job or one that ran here over ssh kept them.
 *
 * A process's owner comes from its own env or from the process group it belongs to: RLM_SESSION_DIR (a box kernel's children and the systemd-run
 * units the sieun-rules shim starts), RLM_HARNESS_STATE_DIR, or LC_PRIME_SESSION, the session id a kernel sets so ssh sends it to this box with
 * the other LC_* variables (sshd here accepts LC_*). Chrome overwrites its environ with its title, so a Chrome takes the owner of the group it
 * runs in. A group is a transient systemd user service (one systemd-run unit) or else the tree under the topmost process below systemd --user,
 * pid 1 or an sshd. A group with no owner signal is listed and never signalled. Prime's own processes and everything under a live kernel, the
 * shared services (pm2 and the Convex watcher under it, Aside, cua-driver) and every process of a unit with a unit file (the chat services,
 * llm-wiki, code-server, the Prime daemon) are never in a group.
 */

/** How long an owner must have ended before its processes stop: the 1 h mac-management asked for on 10-31 after the 47811 driver ran 2 days. */
export const ENDED_FOR_MS = 3_600_000;
/** SIGTERM first, then SIGKILL after this long if the same process still runs (the owner's 10-15 ask, as job-leftovers.ts KILL_AFTER_MS). */
export const KILL_AFTER_MS = 10_000;

/** One process as `worker-footprint.py --owners` prints it. */
export interface ProcRow {
  pid: number; ppid: number; started: number | null; bytes: number | null; command: string;
  sessionDir: string | null; harnessSession: string | null; lcSession: string | null; sshFrom: string | null;
  prime: boolean; shared: boolean; cgroup: string | null; cwd: string | null;
}

/** The session a group's env names: `dir` is its RLM_SESSION_DIR when it ran on this box, `host` the box its kernel runs on. */
export interface Owner { session: string; host: string; dir?: string }
export interface Group { key: string; unit?: string; root: number; pids: number[]; bytes: number; started: number | null; command: string; owners: Owner[] }

export type Verdict = { state: "live"; why: string } | { state: "ended"; at: number; why: string } | { state: "unknown"; why: string };

/** What the reaper knows of one session from its host's roster, the wakes and its transcript. */
export interface SessionFacts {
  rosterStatus?: string | undefined; live?: string | null; topLevel: boolean; archived?: boolean | undefined;
  /** The transcript's mtime in ms, null when no transcript was found. */
  endedAt: number | null;
  /** Why a job above it (never the top-level chat) is live, else null: a live parent job may still use its child's rig. */
  parentLive?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Processes that serve the owner's own tools from outside any agent session. */
const PROTECTED_COMMAND = /(^|\/)convex( |$).*\bdev\b|chat-service-cli\.mjs|\.vscode-server\/|^sshd|^ssh: .*\[mux\]$|sieun-rules\/src\/send-check\.ts/;

/** The user unit a cgroup path ends in, if it lies under a user manager: `.../user@1001.service/app.slice/<unit>`. */
export function unitOf(cgroup: string | null): string | null {
  const match = /\/user@\d+\.service\/(?:[^/]+\.slice\/)*([^/]+\.(?:service|scope))$/.exec(cgroup ?? "");
  return match ? match[1]! : null;
}

const hasUnitFile = (unit: string, files: ReadonlySet<string>): boolean => files.has(unit) || files.has(unit.replace(/@[^.]*\./, "@."));

/**
 * The groups of processes that no Prime process, shared service or unit with a unit file holds. `unitFiles` are the names
 * `systemctl --user list-unit-files` prints; a service without one is a transient systemd-run unit and is one group.
 */
export function groupProcesses(rows: readonly ProcRow[], unitFiles: ReadonlySet<string>, hostOf: (address: string) => string, here: string): Group[] {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const service = (row: ProcRow): string | null => { const unit = unitOf(row.cgroup); return unit?.endsWith(".service") ? unit : null; };
  const kept = (row: ProcRow): boolean => {
    const unit = service(row);
    return row.prime || row.shared || PROTECTED_COMMAND.test(row.command) || (row.cgroup ?? "").includes("/system.slice/") || (unit !== null && unit !== "prime-agent-daemon.service" && hasUnitFile(unit, unitFiles));
  };
  const boundary = (row: ProcRow | undefined): boolean => !row || row.pid <= 1 || /(^|\/)systemd --user/.test(row.command) || /^sshd/.test(row.command);
  /** The topmost process below a boundary, or null when the chain passes a Prime process, a shared service or a kept unit. */
  const rootOf = (row: ProcRow): number | null => {
    let current = row;
    for (let hops = 0; hops < 128; hops++) {
      if (kept(current)) return null;
      const parent = byPid.get(current.ppid);
      if (boundary(parent)) return current.pid;
      current = parent!;
    }
    return null;
  };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (boundary(row)) continue;
    const root = rootOf(row);
    if (root === null) continue;
    const unit = service(row);
    const key = unit && unit !== "prime-agent-daemon.service" ? `unit:${unit}` : `tree:${root}`;
    const group = groups.get(key) ?? { key, ...unit && key.startsWith("unit:") ? { unit } : {}, root, pids: [], bytes: 0, started: null, command: "", owners: [] };
    group.pids.push(row.pid);
    group.bytes += row.bytes ?? 0;
    if (row.started !== null && (group.started === null || row.started < group.started)) { group.started = row.started; group.command = row.command; group.root = row.pid; }
    const owner = ownerOf(row, hostOf, here);
    if (owner && !group.owners.some(known => known.session === owner.session && known.host === owner.host)) group.owners.push(owner);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The owner a process's env names: its RLM_SESSION_DIR, the session of RLM_HARNESS_STATE_DIR, or LC_PRIME_SESSION from the box its ssh came from. */
export function ownerOf(row: ProcRow, hostOf: (address: string) => string, here: string): Owner | null {
  if (row.sessionDir && row.sshFrom === null && row.sessionDir.includes("/session-artifacts/")) return { session: sessionOfDir(row.sessionDir) ?? "", host: here, dir: row.sessionDir };
  if (row.harnessSession && UUID.test(row.harnessSession) && row.sshFrom === null) return { session: row.harnessSession, host: here };
  const tag = /^([0-9a-f-]{36})(?:@(.+))?$/.exec(row.lcSession ?? "");
  if (tag && UUID.test(tag[1]!)) return { session: tag[1]!, host: tag[2] ? hostOf(tag[2]) : row.sshFrom ? hostOf(row.sshFrom) : here };
  return null;
}

/** The hosts.json name of a box from its hostname (`LC_PRIME_SESSION`'s host) or its address (`SSH_CONNECTION`), else the text itself. */
export function hostMatcher(hosts: readonly { name: string; hostname: string; address: string }[]): (text: string) => string {
  const short = (name: string): string => name.split(".")[0]!.toLowerCase();
  return text => hosts.find(host => host.address === text || short(host.hostname) === short(text) || host.name === text)?.name ?? text;
}

/** A root chat's dir is `session-artifacts/<uuid>`, whose name is its id; a job's dir `.../sub-<x>` gets its id from rlm-subagent.json, read later. */
export function sessionOfDir(dir: string): string | null {
  const name = basename(dir.replace(/\/+$/, ""));
  return UUID.test(name) ? name : null;
}

/** Whether a session's processes may stop: live while its roster says running or idle, a wake or queued run waits, it is an unarchived top-level chat, or a job above it is live. */
export function verdict(facts: SessionFacts): Verdict {
  if (facts.rosterStatus === "running" || facts.rosterStatus === "idle") return { state: "live", why: `its roster status is ${facts.rosterStatus}` };
  if (facts.live) return { state: "live", why: facts.live };
  if (facts.topLevel && !facts.archived) return { state: "live", why: "it is a top-level chat, which stays live until it is archived" };
  if (facts.parentLive) return { state: "live", why: facts.parentLive };
  if (facts.endedAt === null) return { state: "unknown", why: "no transcript of it was found" };
  return { state: "ended", at: facts.endedAt, why: facts.archived ? "it is archived" : "it is not resident and nothing waits to wake it" };
}

export interface Decision { stop: Group[]; held: { group: Group; why: string }[]; unknown: Group[] }

/**
 * Splits the groups: stop a group when every owner it names ended over ENDED_FOR_MS ago, hold it when any owner is live or ended more recently,
 * and list a group with no owner or an owner with no transcript as unknown. Only a group whose root left its parent (now under systemd --user,
 * pid 1 or an sshd) or that is a transient unit is listed as unknown, so a terminal's own shell is no unknown orphan.
 */
export function decide(groups: readonly Group[], verdicts: ReadonlyMap<string, Verdict>, now: number): Decision {
  const decision: Decision = { stop: [], held: [], unknown: [] };
  for (const group of groups) {
    if (!group.owners.length) { decision.unknown.push(group); continue; }
    const read = group.owners.map(owner => ({ owner, verdict: verdicts.get(ownerKey(owner)) ?? { state: "unknown", why: "not read" } as Verdict }));
    const live = read.find(entry => entry.verdict.state === "live");
    if (live) { decision.held.push({ group, why: `${live.owner.session} on ${live.owner.host} is live: ${live.verdict.why}` }); continue; }
    if (read.some(entry => entry.verdict.state === "unknown")) { decision.unknown.push(group); continue; }
    const endedAt = Math.max(...read.map(entry => (entry.verdict as { at: number }).at));
    if (now - endedAt < ENDED_FOR_MS) { decision.held.push({ group, why: `its owner ended at ${new Date(endedAt).toISOString()}, under 1 h ago` }); continue; }
    decision.stop.push(group);
  }
  return decision;
}

export const ownerKey = (owner: Owner): string => `${owner.host}/${owner.session}`;

// ---- reads ----

function run(command: string, args: readonly string[], timeout = 60_000): Promise<string> {
  return new Promise((done, fail) => execFile(command, args, { maxBuffer: 256 << 20, timeout }, (error, stdout) => error ? fail(error) : done(stdout)));
}

const HELPER = new URL("./worker-footprint.py", import.meta.url).pathname;
export const readProcesses = async (): Promise<ProcRow[]> => (JSON.parse(await run("python3", [HELPER, "--owners"])) as { processes: ProcRow[] }).processes;

export async function readUnitFiles(): Promise<Set<string>> {
  const text = await run("systemctl", ["--user", "list-unit-files", "--type=service", "--no-legend", "--no-pager"]);
  return unitFileNames(text);
}

/** The unit files `systemctl --user list-unit-files` lists, without the transient units systemd-run made, which it lists too. */
export const unitFileNames = (text: string): Set<string> =>
  new Set(text.split("\n").map(line => line.trim().split(/\s+/)).filter(([name, state]) => name && state !== "transient").map(([name]) => name!));

interface RosterRow { sessionId?: string; rosterStatus?: string; lifecycle?: string; runtimeKind?: string }
const rosterOf = (text: string): Map<string, RosterRow> =>
  new Map(((JSON.parse(text) as { sessions?: RosterRow[] }).sessions ?? []).flatMap(row => row.sessionId ? [[row.sessionId, row] as const] : []));

const mtime = (file: string): Promise<number | null> => stat(file).then(info => info.mtimeMs, () => null);
const artifacts = (home: string): string => join(home, ".prime", "agent", "session-artifacts");

/** The session id and transcript of a box session dir: a root's `<uuid>` names itself, a job's rlm-subagent.json names its transcript. */
async function dirSession(dir: string, home: string): Promise<{ session: string; transcript: string; topLevel: boolean } | null> {
  const own = sessionOfDir(dir);
  if (own && dirname(dir) === artifacts(home)) return { session: own, transcript: join(home, ".prime", "agent", "sessions", `${own}.jsonl`), topLevel: true };
  const record = await readFile(join(dir, "rlm-subagent.json"), "utf8").then(text => JSON.parse(text) as { sessionFile?: unknown }, () => null);
  const file = typeof record?.sessionFile === "string" ? record.sessionFile : null;
  return file ? { session: basename(file, ".jsonl"), transcript: file, topLevel: false } : null;
}

/** `list` prints a host's `prime-agent list --json` (with `--all` for every saved session), `remote` runs a shell command on another host. */
export interface ReadContext { here: string; home: string; dataDir: string; now: number; list: (host: string, all: boolean) => Promise<string>; remote: (host: string, command: string) => Promise<string> }

/** The verdict of every owner the groups name, with each owner's session id filled in from its dir. */
export async function readVerdicts(groups: Group[], context: ReadContext): Promise<Map<string, Verdict>> {
  const verdicts = new Map<string, Verdict>();
  const paths = livePaths(context.dataDir, context.home);
  const rosters = new Map<string, Promise<Map<string, RosterRow>>>();
  const roster = (host: string): Promise<Map<string, RosterRow>> => {
    if (!rosters.has(host)) rosters.set(host, context.list(host, false).then(rosterOf));
    return rosters.get(host)!;
  };
  let archive: Promise<Map<string, RosterRow>> | null = null;
  const all = (): Promise<Map<string, RosterRow>> => archive ??= context.list(context.here, true).then(rosterOf);
  const liveJob = async (session: string, host: string): Promise<string | null> => {
    const row = (await roster(host)).get(session);
    if (row?.rosterStatus === "running" || row?.rosterStatus === "idle") return `its roster status is ${row.rosterStatus}`;
    return jobLive(paths, session, context.now);
  };
  for (const group of groups) for (const owner of group.owners) {
    let facts: SessionFacts | null = null;
    if (owner.dir) {
      const found = await dirSession(owner.dir, context.home);
      if (!found) { owner.session ||= basename(owner.dir); verdicts.set(ownerKey(owner), { state: "unknown", why: `${owner.dir} names no transcript` }); continue; }
      owner.session = found.session;
      if (verdicts.has(ownerKey(owner))) continue;
      facts = await boxFacts(found, owner.dir, context, roster, all, liveJob);
    } else {
      if (verdicts.has(ownerKey(owner))) continue;
      try { facts = owner.host === context.here ? await boxFactsById(owner.session, context, roster, all) : await remoteFacts(owner, context, roster); }
      catch (error) { verdicts.set(ownerKey(owner), { state: "unknown", why: `${owner.host} did not answer: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` }); continue; }
    }
    if (facts.rosterStatus !== "running" && facts.rosterStatus !== "idle" && !facts.live) facts.live = await jobLive(paths, owner.session, context.now);
    verdicts.set(ownerKey(owner), verdict(facts));
  }
  return verdicts;
}

async function boxFacts(found: { session: string; transcript: string; topLevel: boolean }, dir: string, context: ReadContext,
  roster: (host: string) => Promise<Map<string, RosterRow>>, all: () => Promise<Map<string, RosterRow>>, liveJob: (session: string, host: string) => Promise<string | null>): Promise<SessionFacts> {
  const row = (await roster(context.here)).get(found.session);
  const archived = found.topLevel && !row ? (await all()).get(found.session)?.lifecycle === "archived" : undefined;
  let parentLive: string | null = null;
  for (let up = dirname(dir); /^sub-/.test(basename(up)) && !parentLive; up = dirname(up)) {
    const parent = await dirSession(up, context.home);
    const why = parent ? await liveJob(parent.session, context.here) : null;
    if (parent && why) parentLive = `its parent job ${parent.session} is live: ${why}`;
  }
  return { rosterStatus: row?.rosterStatus, topLevel: found.topLevel, archived, endedAt: await mtime(found.transcript), parentLive };
}

/** A box session known only by id (RLM_HARNESS_STATE_DIR, or LC_PRIME_SESSION with no RLM_SESSION_DIR): a top-level chat or a job found in the full list. */
async function boxFactsById(session: string, context: ReadContext, roster: (host: string) => Promise<Map<string, RosterRow>>, all: () => Promise<Map<string, RosterRow>>): Promise<SessionFacts> {
  const row = (await roster(context.here)).get(session);
  const top = join(context.home, ".prime", "agent", "sessions", `${session}.jsonl`);
  const topAt = await mtime(top);
  if (topAt !== null) return { rosterStatus: row?.rosterStatus, topLevel: true, archived: (await all()).get(session)?.lifecycle === "archived", endedAt: topAt };
  return { rosterStatus: row?.rosterStatus, topLevel: false, endedAt: null };
}

/** A session on another box: its roster there and its transcript's mtime there, a top-level chat's under sessions/ and a job's two levels under session-artifacts. */
async function remoteFacts(owner: Owner, context: ReadContext, roster: (host: string) => Promise<Map<string, RosterRow>>): Promise<SessionFacts> {
  const row = (await roster(owner.host)).get(owner.session);
  const id = owner.session;
  const listing = await context.remote(owner.host, `cd ~/.prime/agent && for f in sessions/${id}.jsonl session-artifacts/*/sub-*/${id}.jsonl session-artifacts/*/sub-*/sub-*/${id}.jsonl; do [ -f "$f" ] && echo "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f") $f"; done; true`);
  const line = listing.split("\n").find(entry => entry.trim());
  const [seconds, file] = line ? line.trim().split(" ") : [];
  return { rosterStatus: row?.rosterStatus, topLevel: file?.startsWith("sessions/") ?? false, endedAt: seconds ? Number(seconds) * 1000 : null };
}

// ---- stop ----

export interface StopSource { starts: () => Promise<ReadonlyMap<number, number | null>>; kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void; wait: (ms: number) => Promise<void> }

/** SIGTERM every process of the groups that still runs with the start time the scan read, then SIGKILL the ones that still do after KILL_AFTER_MS. */
export async function stopGroups(groups: readonly Group[], rows: readonly ProcRow[], source: StopSource): Promise<{ signalled: number[]; killed: number[] }> {
  const startOf = new Map(rows.map(row => [row.pid, row.started]));
  const same = (starts: ReadonlyMap<number, number | null>, pid: number): boolean => starts.has(pid) && starts.get(pid) !== null && starts.get(pid) === startOf.get(pid);
  const signal = (pids: readonly number[], name: "SIGTERM" | "SIGKILL"): number[] => pids.filter(pid => {
    try { source.kill(pid, name); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  });
  const before = await source.starts();
  const signalled = signal(groups.flatMap(group => group.pids).filter(pid => same(before, pid)), "SIGTERM");
  if (!signalled.length) return { signalled, killed: [] };
  await source.wait(KILL_AFTER_MS);
  const after = await source.starts();
  return { signalled, killed: signal(signalled.filter(pid => same(after, pid)), "SIGKILL") };
}

export const liveStopSource: StopSource = {
  starts: async () => new Map((await readProcesses()).map(row => [row.pid, row.started])),
  kill: (pid, signal) => process.kill(pid, signal),
  wait: ms => new Promise(done => setTimeout(done, ms)),
};

// ---- the d2 reading ----

export interface Reading { orphan_processes: number; orphan_unknown: number; stop: Group[]; held: { group: Group; why: string }[]; unknown: Group[]; verdicts: Map<string, Verdict> }

const age = (group: Group, now: number): string => group.started === null ? "?" : `${((now / 1000 - group.started) / 3600).toFixed(1)} h`;
const mb = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`;
export function describe(group: Group, now: number, verdicts?: ReadonlyMap<string, Verdict>): string {
  const owners = group.owners.map(owner => { const read = verdicts?.get(ownerKey(owner)); return `${owner.session} on ${owner.host}${read?.state === "ended" ? ` ended ${new Date(read.at).toISOString().slice(5, 16)}Z` : ""}`; });
  return `${group.unit ?? `pid ${group.root}`}: ${group.pids.length} processes, ${mb(group.bytes)}, ${age(group, now)}, ${group.command.slice(0, 120)}${owners.length ? `; owner ${owners.join(", ")}` : "; no owner signal"}`;
}

export async function readOrphans(context: ReadContext, hostOf: (address: string) => string): Promise<{ rows: ProcRow[]; reading: Reading }> {
  const [rows, unitFiles] = await Promise.all([readProcesses(), readUnitFiles()]);
  const groups = groupProcesses(rows, unitFiles, hostOf, context.here);
  const owned = groups.filter(group => group.owners.length);
  const verdicts = await readVerdicts(owned, context);
  const decision = decide(groups, verdicts, context.now);
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const orphaned = (group: Group): boolean => {
    const ppid = byPid.get(group.root)?.ppid ?? 0;
    return group.unit !== undefined || ppid === 1 || /(^|\/)systemd --user/.test(byPid.get(ppid)?.command ?? "");
  };
  const unknown = decision.unknown.filter(orphaned);
  return { rows, reading: { orphan_processes: decision.stop.reduce((sum, group) => sum + group.pids.length, 0), orphan_unknown: unknown.reduce((sum, group) => sum + group.pids.length, 0),
    stop: decision.stop, held: decision.held, unknown, verdicts } };
}

/** The box's own Prime is `prime-agent` on PATH; another box's wrapper is not on its ssh PATH, so it runs by its install path there. */
export const defaultContext = (here: string, now: number): ReadContext => {
  const remote = (host: string, command: string): Promise<string> => run("ssh", ["-o", "BatchMode=yes", host, command]);
  return { here, home: homedir(), dataDir: join(homedir(), ".prime", "agent", "browser-chat"), now, remote,
    list: (host, all) => host === here ? run("prime-agent", ["list", ...all ? ["--all"] : [], "--json"]) : remote(host, `~/.local/share/prime-agent/bin/prime-agent list${all ? " --all" : ""} --json`) };
};
