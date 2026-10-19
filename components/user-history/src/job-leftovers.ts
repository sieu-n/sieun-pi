import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Host } from "./hosts.ts";
import { WIKI_CONTENT_DIR } from "./chat-wiki.ts";
import type { RawProcess } from "./mac-usable-watch.ts";
import { stopOrphanServices } from "./orphan-services.ts";

/**
 * What a job leaves behind once it is gone, and the stop of it. On 10-15 at 00:45Z a deleted job's nohup'd runner.py went on to start a 30 GB
 * script, and on 10-16 at 01:40Z two `message-limit-check.py wait-start` waiters of a chat whose kernel had died still ran, and the Aside
 * browser held tabs whose jobs were gone; the delete notice only named the processes and asked the chat to stop them. Now the service stops them
 * itself: every process that carries the RLM_HARNESS_STATE_DIR of the job's session or of a session under it (its subagents) and sits under no
 * kernel and no Prime process (worker-footprint.py `strays`), and every Aside tab those sessions opened (`aside-browser-tabs.json` in their
 * session folders). Shared services (PM2, Aside, cua-driver) and Prime's own processes are never named, so ops guy's pm2 dev servers stay.
 * It also deletes the repo copies a job left in its wiki session folders and the kernel-state.dill files and repo copies its sessions left in
 * their own session-artifacts folders. It never deletes a path or signals a process only because a transcript names it or a process's
 * arguments name the path: on 10-19 the job end deleted ~/scratch/retire-2547, release-fold and saved-session-archive, whose evidence the chat
 * still read, and at 02:06Z the end of job metal agent verification deleted the shared ~/scratch/release-applied and SIGTERMed four release
 * processes of other jobs (3085180, 3469500, 3567932, 3850115) that ran the release helper from it under systemd-run.
 * It also stops the scopes of the services its sessions handed off before their kernels were freed.
 */

export const ARTIFACTS = join(homedir(), ".prime", "agent", "session-artifacts");
const HELPER = new URL("./worker-footprint.py", import.meta.url).pathname;
/** SIGTERM first, then SIGKILL after this long if the same process still runs (the owner's 10-15 ask: "SIGTERM, then SIGKILL after 10 s"). */
export const KILL_AFTER_MS = 10_000;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const TABS_FILE = "aside-browser-tabs.json";

/**
 * `units` are the transient units the job's record names and the scopes of services its sessions handed off before their kernels were freed
 * (`orphan-services.ts`), both stopped. `elsewhere` are the units a record named on a box with no systemd (the Mac), which a Mac job started
 * on us-metal02 over ssh, for the box that runs them to stop (`hostLeftovers`).
 */
export interface Leftovers { stopped: readonly RawProcess[]; tabs: number; copies: readonly string[]; artifacts: readonly string[]; owned: readonly string[]; units: readonly string[];
  elsewhere?: readonly string[] }
/** A process that runs in or holds a /tmp tree (worker-footprint.py `--inside`): the session it carries (none for the rig's own processes), whether it is Prime outside the rig, or a shared service. */
export interface InsideProcess extends RawProcess { dir: string; session: string | null; prime: boolean; shared: boolean }
export interface LeftoverSource {
  /** The detached processes of these sessions (worker-footprint.py `--session`). */
  strays: (sessions: readonly string[]) => Promise<readonly RawProcess[]>;
  /** A process's start time in epoch seconds, null when it is gone. */
  started: (pid: number) => Promise<number | null>;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Closes the Aside tabs among these target ids that are still open; returns how many it closed. */
  closeTabs: (ids: readonly string[]) => Promise<number>;
  later: (ms: number, run: () => void) => void;
  /** Deletes the repo copies left in the wiki session folders these transcripts opened (`removeRepoCopies`); returns the folders it deleted. */
  removeCopies: (transcripts: readonly string[]) => Promise<readonly string[]>;
  /** The processes that run in or hold these dirs (worker-footprint.py `--inside`). */
  inside: (dirs: readonly string[]) => Promise<readonly InsideProcess[]>;
  /** Deletes these dirs; returns the ones it deleted. */
  removeTmp: (dirs: readonly string[]) => Promise<readonly string[]>;
  /**
   * Stops these user units where they are active and transient (`systemd-run`), so a recorded unit file such as the chat service never stops;
   * returns the ones it stopped, or null on a box with no systemd, where the units run on another box.
   */
  stopUnits: (units: readonly string[]) => Promise<readonly string[] | null>;
  /** Writes an ownership record back (`endOwned`). */
  writeOwned: (file: string, record: OwnedRecord) => Promise<void>;
  /** The repo copies the sessions of these transcripts left in their own session folders (`artifactCopies`). */
  artifactCopies: (transcripts: readonly string[]) => Promise<readonly string[]>;
  /** The kernel-state.dill files of the sessions of these transcripts (`kernelStates`). */
  kernelStates: (transcripts: readonly string[]) => Promise<readonly string[]>;
  /** Stops the scopes of the services these sessions handed off and removes their records (`stopOrphanServices`); returns the units. */
  stopServices: (sessions: readonly string[]) => Promise<readonly string[]>;
}

/** The session ids, transcripts, Aside tab ids, tab record files and ownership records (`OWNED_FILE`) of a session folder and every folder under it (its subagents). */
export async function sessionTree(dir: string): Promise<{ sessions: string[]; transcripts: string[]; tabs: string[]; tabFiles: string[]; ownedFiles: string[] }> {
  const sessions: string[] = [];
  const transcripts: string[] = [];
  const tabs: string[] = [];
  const tabFiles: string[] = [];
  const ownedFiles: string[] = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (SESSION_FILE.test(entry.name)) {
      sessions.push(entry.name.slice(0, -".jsonl".length));
      transcripts.push(join(entry.parentPath, entry.name));
    }
    else if (entry.name === OWNED_FILE) ownedFiles.push(join(entry.parentPath, entry.name));
    else if (entry.name === TABS_FILE) {
      const file = join(entry.parentPath, entry.name);
      const record = await readFile(file, "utf8").then(text => JSON.parse(text) as { tabs?: unknown }, () => null);
      const ids = record && typeof record.tabs === "object" && record.tabs ? Object.keys(record.tabs) : [];
      if (ids.length) { tabs.push(...ids); tabFiles.push(file); }
    }
  }
  return { sessions, transcripts, tabs, tabFiles, ownedFiles };
}

/**
 * A session's ownership record, `owned.json` in its RLM_SESSION_DIR, which board.own() writes: `{"paths": [...], "units": [...]}`, the paths
 * and the systemd user units the session made to throw away. A job's end deletes and stops only what these records name, since a path a
 * transcript or a process's arguments only name proves no owner: on 10-19 at 02:06Z the end of job metal agent verification deleted the shared
 * ~/scratch/release-applied and SIGTERMed four release processes of other jobs that ran a helper from it.
 */
export const OWNED_FILE = "owned.json";
/** The folders an owned path must lie strictly below; a path in the home folder must lie below one of them there, even when the home lies in /tmp. */
export const OWNED_ROOTS: readonly string[] = ["/tmp", join(homedir(), "scratch"), ARTIFACTS];
const UNIT = /^[A-Za-z0-9:_.@-]{1,200}\.(service|scope|timer)$/;

export interface OwnedRecord { paths: string[]; units: string[] }

/**
 * The record's paths that lie strictly below an `OWNED_ROOTS` folder, outside every session folder of session-artifacts and away from `dirs`
 * and anything above them, and its units with a unit name; anything else in the file is dropped.
 */
export async function readOwned(file: string, dirs: readonly string[] = []): Promise<OwnedRecord> {
  const record = await readFile(file, "utf8").then(text => JSON.parse(text) as { paths?: unknown; units?: unknown }, () => null);
  const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const paths = list(record?.paths).filter(path => path.startsWith("/")).map(path => normalize(path).replace(/\/+$/, "")).filter(path =>
    OWNED_ROOTS.some(root => path.startsWith(root + "/")) &&
    (!path.startsWith(homedir() + "/") || OWNED_ROOTS.some(root => root.startsWith(homedir() + "/") && path.startsWith(root + "/"))) &&
    !(path.startsWith(ARTIFACTS + "/") && SESSION_DIR.test(path.slice(ARTIFACTS.length + 1).split("/")[0]!)) &&
    !dirs.some(dir => dir === path || dir.startsWith(path + "/")));
  return { paths: [...new Set(paths)], units: [...new Set(list(record?.units).filter(unit => UNIT.test(unit)))] };
}

/** Whether `path` is a file or folder our user owns, not a symlink. */
async function ours(path: string): Promise<boolean> {
  const item = await lstat(path).catch(() => null);
  const uid = process.getuid?.();
  return !!item && !item.isSymbolicLink() && (uid === undefined || item.uid === uid);
}

/**
 * Stops the units and deletes the paths the ownership records of gone sessions name (`readOwned`), and keeps a path any process runs in, holds
 * or names. Each record keeps the paths that are still there, so a later sweep deletes one once nothing holds it.
 */
async function endOwned(source: LeftoverSource, files: readonly string[], dirs: readonly string[]): Promise<{ owned: readonly string[]; units: readonly string[]; elsewhere: readonly string[] }> {
  if (!files.length) return { owned: [], units: [], elsewhere: [] };
  const records = await Promise.all(files.map(file => readOwned(file, dirs)));
  const wanted = [...new Set(records.flatMap(record => record.units))];
  const answer = wanted.length ? await source.stopUnits(wanted).catch(() => []) : [];
  const units = answer ?? [];
  const elsewhere = answer === null ? wanted : [];
  const paths: string[] = [];
  for (const path of new Set(records.flatMap(record => record.paths))) if (await ours(path)) paths.push(path);
  const held = new Set(paths.length ? (await source.inside(paths)).map(entry => entry.dir) : []);
  const free = paths.filter(path => !held.has(path));
  const owned = free.length ? await source.removeTmp(free) : [];
  const gone = new Set(owned);
  await Promise.all(files.map(async (file, index) => {
    const left = { paths: records[index]!.paths.filter(path => !gone.has(path) && paths.includes(path)), units: [] };
    await source.writeOwned(file, left).catch(() => {});
  }));
  return { owned, units, elsewhere };
}

/**
 * The wiki session folders a transcript opened, from the answer of `POST /api/agent/sessions`, `{"id":"sessions/<day>/<hhmm-slug>","path":
 * "<id>/index.html",...}`, printed raw, as a Python dict or escaped inside a tool result.
 */
const OPENED_SESSION = /id[\\"']*\s*:\s*[\\"']*(sessions\/\d{4}\/\d{2}\/\d{2}\/\d{4}-[a-z0-9-]+)[\\"']*\s*,\s*[\\"']*path[\\"']*\s*:\s*[\\"']*\1\/index\.html/g;

export async function openedWikiSessions(transcripts: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const file of transcripts) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const match of text.matchAll(OPENED_SESSION)) found.add(match[1]!);
  }
  return [...found];
}

/**
 * The repo copies under a wiki session folder: each folder below it that holds `.git`, `pnpm-workspace.yaml` or `scripts/repo` (a clone or a
 * `git archive` export), a bare git repo (`HEAD`, `objects` and `refs`, a `git clone --mirror`), or an `apps/<app>` with its `package.json` or
 * `pyproject.toml` (a `git archive <sha> apps/<app>` export), and each `node_modules` and `.venv`. On 10-18 the session folders held 502 such
 * copies with 1.3M of their 1.7M files, and the wiki index, `git status` and every walker paid for them. At 16:46Z, after the job line moved
 * scratch trees out, 41 app exports (1.9 GB), 3 mirrors (1.2 GB) and a `.venv` were still there, which the first three markers missed.
 */
export async function repoCopies(folder: string): Promise<string[]> {
  const copies: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === "node_modules" || entry.name === ".venv") { copies.push(path); continue; }
      if (await isRepoCopy(path)) copies.push(path);
      else await walk(path);
    }
  };
  await walk(folder);
  return copies;
}

/** Whether a folder is a repo copy by the markers of `repoCopies`. */
async function isRepoCopy(path: string): Promise<boolean> {
  const inside = await readdir(path, { withFileTypes: true }).catch(() => []);
  const names = new Set(inside.map(item => item.name));
  const apps = inside.some(item => item.name === "apps" && item.isDirectory()) ? await readdir(join(path, "apps"), { withFileTypes: true }).catch(() => []) : [];
  return names.has(".git") || names.has("pnpm-workspace.yaml") ||
    inside.some(item => item.name === "scripts" && item.isDirectory() && existsSync(join(path, "scripts", "repo"))) ||
    (names.has("HEAD") && names.has("objects") && names.has("refs")) ||
    apps.some(app => app.isDirectory() && ["package.json", "pyproject.toml"].some(file => existsSync(join(path, "apps", app.name, file))));
}

/** Whether git tracks a file under this path of the wiki content (an export a job meant to keep, such as 1458-land37-staging-converge-fix/drafts/u2). A failing git counts as tracked. */
function tracked(contentDir: string, path: string): Promise<boolean> {
  return new Promise(resolve => {
    const git = spawn("git", ["-C", contentDir, "ls-files", "-z", "--", path], { stdio: ["ignore", "pipe", "ignore"] });
    let any = false;
    git.stdout.once("data", () => { any = true; git.kill(); });
    git.once("error", () => resolve(true));
    git.once("close", code => resolve(any || code !== 0 && code !== null));
  });
}

/** Deletes the untracked repo copies (`repoCopies`) in the wiki session folders the transcripts opened, and returns the folders it deleted. */
export async function removeRepoCopies(transcripts: readonly string[], contentDir = WIKI_CONTENT_DIR,
  isTracked: (contentDir: string, path: string) => Promise<boolean> = tracked): Promise<string[]> {
  const removed: string[] = [];
  for (const session of await openedWikiSessions(transcripts)) {
    for (const copy of await repoCopies(join(contentDir, session))) {
      if (await isTracked(contentDir, copy)) continue;
      await rm(copy, { recursive: true, force: true });
      removed.push(copy);
    }
  }
  return removed;
}

/**
 * The folders under a chat's session folder of the subagents the daemon marked deleted (`"status": "deleted"` in rlm-subagent.json). A job the
 * chat deletes itself with rlm.delete_subagent stays in the daemon's list, so this file is the one sign that it is gone: on 10-16 at 08:42Z
 * clean room chat 01a1435e deleted "tmp web server setsid", and its setsid'd http.server on 8767 and its Aside tab outlived it until a reboot.
 */
export async function deletedFolders(chatDir: string): Promise<string[]> {
  const entries = await readdir(chatDir, { recursive: true, withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== "rlm-subagent.json") continue;
    const record = await readFile(join(entry.parentPath, entry.name), "utf8").then(text => JSON.parse(text) as { status?: unknown }, () => null);
    if (record?.status === "deleted") found.push(entry.parentPath);
  }
  return found.filter(dir => !found.some(other => other !== dir && dir.startsWith(other + "/")));
}

/** Top-level /tmp names every session shares (caches, sockets, Prime's own dir), never one job's tree. */
export const SHARED_TMP = /^(prime-agent-\d+|tsx-\d+|node-compile-cache|v8-compile-cache-\d+|pytest-of-.+|systemd-private-.+|tmux-\d+|ssh-.+|snap-private-tmp|jiti|\.[\w-]+-unix)$/;
const KERNEL_STATE = /^kernel-state\.dill(\.[A-Za-z0-9]+\.tmp)?$/;
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The kernel-state.dill files of these sessions: a kernel's saved namespace, kept under its parent's `session-artifacts/<id>/`, which only a
 * resume of that session reads. On 10-18 the 4,000 subagents the daemon had deleted on us-metal02 still held 3.9 GB of them.
 */
export async function kernelStates(transcripts: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const file of transcripts) {
    const kernel = join(dirname(dirname(file)), "session-artifacts", file.slice(file.lastIndexOf("/") + 1, -".jsonl".length));
    for (const entry of await readdir(kernel).catch(() => [])) if (KERNEL_STATE.test(entry)) found.push(join(kernel, entry));
  }
  return found;
}

/**
 * The repo copies (`repoCopies`) gone sessions left in their own folders of ~/.prime/agent/session-artifacts, the folders that hold their
 * transcripts. A folder elsewhere in session-artifacts that a transcript only names is never read: on 10-19 at 02:06Z the end of job metal agent
 * verification deleted ~/scratch/release-applied, which it had named and other jobs ran their release helper from, so a named path proves no owner.
 */
export async function artifactCopies(transcripts: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const file of transcripts) for (const copy of await repoCopies(dirname(file))) found.add(copy);
  return [...found];
}

/** SIGTERM to each process whose start time still matches, then SIGKILL after KILL_AFTER_MS to each one still running with that start time. */
export async function stopProcesses(source: Pick<LeftoverSource, "started" | "kill" | "later">, found: readonly RawProcess[]): Promise<RawProcess[]> {
  const stopped: RawProcess[] = [];
  for (const entry of found) {
    if (entry.pid <= 1 || entry.pid === process.pid || entry.started === null || await source.started(entry.pid) !== entry.started) continue;
    try { source.kill(entry.pid, "SIGTERM"); } catch { continue; }
    stopped.push(entry);
  }
  if (stopped.length) source.later(KILL_AFTER_MS, () => {
    void Promise.all(stopped.map(async entry => {
      if (await source.started(entry.pid).catch(() => null) === entry.started) try { source.kill(entry.pid, "SIGKILL"); } catch { /* gone */ }
    }));
  });
  return stopped;
}

/**
 * Stops what gone jobs left: their sessions' detached processes and their Aside tabs, whose records are then emptied so a later sweep does not
 * open Aside for them again, deletes the repo copies they left in the wiki session folders they opened, deletes the kernel states and repo
 * copies they left in their session-artifacts folders (`endArtifacts`), and stops the units and deletes the paths their ownership records name
 * (`endOwned`). With `session`, the processes are read again after KILL_AFTER_MS, since a kernel the daemon is still ending at the
 * delete leaves its children detached only once it exits.
 */
export async function endLeftovers(source: LeftoverSource, dirs: string | readonly string[], session?: string): Promise<Leftovers> {
  const trees = await Promise.all((typeof dirs === "string" ? [dirs] : dirs).map(sessionTree));
  const sessions = [...new Set([...(session ? [session] : []), ...trees.flatMap(tree => tree.sessions)])];
  const handed = sessions.length ? await source.stopServices(sessions).catch(() => []) : [];
  const stopped = sessions.length ? await stopProcesses(source, await source.strays(sessions)) : [];
  if (session) source.later(KILL_AFTER_MS, () => { void source.strays(sessions).then(found => stopProcesses(source, found)).catch(() => []); });
  const ids = trees.flatMap(tree => tree.tabs);
  const tabs = ids.length ? await source.closeTabs(ids).catch(() => -1) : 0;
  if (tabs >= 0) for (const file of trees.flatMap(tree => tree.tabFiles)) {
    const record = await readFile(file, "utf8").then(text => JSON.parse(text) as Record<string, unknown>, () => null);
    if (record) await writeFile(file, JSON.stringify({ ...record, tabs: {} })).catch(() => {});
  }
  const transcripts = trees.flatMap(tree => tree.transcripts);
  const copies = await source.removeCopies(transcripts).catch(() => []);
  const artifacts = await endArtifacts(source, transcripts).catch(() => []);
  const owned = await endOwned(source, trees.flatMap(tree => tree.ownedFiles), typeof dirs === "string" ? [dirs] : dirs).catch(() => ({ owned: [], units: [], elsewhere: [] }));
  return { stopped, tabs: Math.max(tabs, 0), copies, artifacts, owned: owned.owned, units: [...handed, ...owned.units], ...owned.elsewhere.length ? { elsewhere: owned.elsewhere } : {} };
}

/** Deletes the kernel-state.dill files and the repo copies gone sessions left in session-artifacts, and keeps a copy any process runs in or holds. */
async function endArtifacts(source: LeftoverSource, transcripts: readonly string[]): Promise<readonly string[]> {
  const [copies, states] = await Promise.all([source.artifactCopies(transcripts), source.kernelStates(transcripts)]);
  const held = new Set(copies.length ? (await source.inside(copies)).map(entry => entry.dir) : []);
  const free = [...states, ...copies.filter(copy => !held.has(copy))];
  return free.length ? source.removeTmp(free) : [];
}

function helper(args: readonly string[], input = ""): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/python3", ["-B", HELPER, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout) as unknown); } catch (failure) { reject(failure); }
    });
    child.stdin?.end(input);
  });
}

/** Runs `systemctl --user` with these arguments: whether it exited 0, and its trimmed stdout. */
function systemctl(args: readonly string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    execFile("systemctl", ["--user", ...args], { maxBuffer: 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, output: String(stdout).trim() }));
  });
}

/**
 * Closes Aside tabs with a one-shot `aside repl`: each still open tab is attached and runs window.close(), and the count is what the next list
 * no longer shows within 5 s (on 10-17 at 20:39Z, under load, a 500 ms look counted 0 for a tab that did close). closeTab closes only a tab its own REPL session opened; from another session it only lets the tab go (tried 10-16 01:5xZ
 * through both `aside repl` and `aside mcp`, and the tab stayed open), and a gone job's session is gone.
 */
export function closeAsideTabs(ids: readonly string[], cli = process.env.ASIDE_CLI ?? join(homedir(), ".local", "bin", "aside")): Promise<number> {
  const code = `const __leftoverIds = ${JSON.stringify(ids)}; const __leftoverOpen = new Set((await listBrowserTabs()).map(tab => tab.targetId));
for (const id of __leftoverIds) if (__leftoverOpen.has(id)) { const tab = await attachBrowserTab(id); await tab.evaluate(() => window.close()).catch(() => {}); }
let __leftoverLeft = new Set(); for (let i = 0; i < 20; i++) { await sleep(250); __leftoverLeft = new Set((await listBrowserTabs()).map(tab => tab.targetId)); if (!__leftoverIds.some(id => __leftoverLeft.has(id))) break; }
console.log("LEFTOVER_CLOSED " + __leftoverIds.filter(id => __leftoverOpen.has(id) && !__leftoverLeft.has(id)).length);`;
  return new Promise((resolve, reject) => {
    execFile(cli, ["repl", code], { timeout: 130_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const closed = /LEFTOVER_CLOSED (\d+)/.exec(stdout);
      if (closed) resolve(Number(closed[1]));
      else reject(error ?? new Error(`aside repl: ${(stdout + stderr).slice(0, 300)}`));
    });
  });
}

/** Transcripts whose wiki session folders and session-artifacts copies were already cleared, so the sweep of deleted jobs reads each transcript once. */
const copiesCleared = new Set<string>();
const artifactsCleared = new Set<string>();

/** The real source: the footprint helper, process.kill, `aside repl`, timers that do not hold the service open and `removeRepoCopies`. */
export const leftoverSource: LeftoverSource = {
  strays: async sessions => {
    const answer = await helper(["--session", sessions.join(",")]) as { strays?: RawProcess[] };
    return Array.isArray(answer?.strays) ? answer.strays : [];
  },
  started: async pid => { const answer = await helper(["--started", String(pid)]); return typeof answer === "number" ? answer : null; },
  kill: (pid, signal) => { process.kill(pid, signal); },
  closeTabs: ids => closeAsideTabs(ids),
  later: (ms, run) => { setTimeout(run, ms).unref(); },
  removeCopies: transcripts => {
    const fresh = transcripts.filter(file => !copiesCleared.has(file));
    for (const file of fresh) copiesCleared.add(file);
    return removeRepoCopies(fresh);
  },
  inside: async dirs => {
    const answer = await helper(["--inside"], dirs.join("\n") + "\n") as { inside?: InsideProcess[] };
    return Array.isArray(answer?.inside) ? answer.inside : [];
  },
  removeTmp: async dirs => {
    const removed: string[] = [];
    for (const dir of dirs) if (await rm(dir, { recursive: true, force: true }).then(() => true, () => false)) removed.push(dir);
    return removed;
  },
  stopUnits: async units => {
    if (process.platform !== "linux") return null;
    const stopped: string[] = [];
    for (const unit of units) {
      const state = Object.fromEntries((await systemctl(["show", "-p", "ActiveState,Transient", "--", unit])).output.split("\n").map(line => line.split("=", 2)));
      if (state.Transient !== "yes" || !["active", "activating", "reloading"].includes(state.ActiveState ?? "")) continue;
      if ((await systemctl(["stop", "--", unit])).ok) stopped.push(unit);
    }
    return stopped;
  },
  writeOwned: (file, record) => writeFile(file, JSON.stringify(record)),
  artifactCopies: transcripts => {
    const fresh = transcripts.filter(file => !artifactsCleared.has(file));
    for (const file of fresh) artifactsCleared.add(file);
    return fresh.length ? artifactCopies(fresh) : Promise.resolve([]);
  },
  kernelStates: transcripts => kernelStates(transcripts),
  stopServices: sessions => stopOrphanServices(sessions),
};

/** A replay serve's source (`serve --replay-daemon`): the same reads, with no kill, unit stop, tab close, delete or record write, and a tab count of -1 so no tab record is emptied. */
export const dryLeftoverSource: LeftoverSource = { ...leftoverSource, kill: () => {}, closeTabs: async () => -1, removeCopies: async () => [], removeTmp: async () => [],
  stopUnits: async () => [], writeOwned: async () => {} };

/** Runs this module's CLI (`main`) on another box with these arguments and returns what it printed. */
export type RemoteLeftovers = (host: Host, args: readonly string[]) => Promise<Leftovers>;

/** A session-artifacts path below ARTIFACTS as the CLI takes it, `<session>[/sub-...]`; null for anything else. */
const ARTIFACT_PATH = /^[0-9a-f-]{36}(\/sub-[0-9a-f]+)*$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Ends a gone job's leftovers on the box whose daemon runs the session that owns its folder, the first name below ARTIFACTS (a chat for its
 * jobs, a root for itself). A Mac chat's job folders, owned.json records, detached processes and Aside tabs are all on the Mac, so the chat
 * service on us-metal02 found no folder at their end and stopped nothing: on 10-19 the Mac's signup and add brand jobs recorded world units
 * they started on us-metal02 over ssh in owned.json files only the Mac holds. The other box runs the cleanup itself (`main`, over ssh), and
 * the units its records name that it has no systemd for are stopped here.
 */
export function hostLeftovers(options: { local: LeftoverSource; hostOf: (session: string) => Host | null; remote?: RemoteLeftovers | undefined }): {
  leftovers: (dir: string, session?: string) => Promise<Leftovers>; deleted: (chat: string) => Promise<Leftovers>;
} {
  const { local, hostOf, remote } = options;
  const there = async (host: Host, args: readonly string[]): Promise<Leftovers> => {
    const left = await remote!(host, args);
    const stopped = left.elsewhere?.length ? await local.stopUnits(left.elsewhere).catch(() => []) ?? [] : [];
    return { ...left, units: [...left.units, ...stopped] };
  };
  return {
    leftovers: async (dir, session) => {
      const path = relative(ARTIFACTS, dir);
      const host = remote && ARTIFACT_PATH.test(path) ? hostOf(path.split("/")[0]!) : null;
      return host ? there(host, ["end", path, ...session && SESSION.test(session) ? [session] : []]) : endLeftovers(local, dir, session);
    },
    deleted: async chat => {
      const host = remote && SESSION.test(chat) ? hostOf(chat) : null;
      return host ? there(host, ["deleted", chat]) : endLeftovers(local, await deletedFolders(join(ARTIFACTS, chat)));
    },
  };
}

/**
 * The CLI over ssh in the other box's own sieun-pi checkout (`sieun-pi source`), as Settings > Tools and skills runs its checks there
 * (chat-tools.ts `sshChecks`, whose ConnectTimeout=10 is the box's aside wrapper's).
 */
export const sshLeftovers: RemoteLeftovers = (host, args) => new Promise((resolve, reject) => {
  if (!host.ssh) { reject(new Error(`hosts.json gives ${host.name} no ssh target`)); return; }
  const command = `PATH="$HOME/.local/bin:$PATH"; cd "$(sieun-pi source)/components/user-history" && exec node --import tsx src/job-leftovers.ts ${args.map(arg => `'${arg}'`).join(" ")}`;
  execFile("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host.ssh, command], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    try { if (!error) { resolve(JSON.parse(String(stdout).trim().split("\n").at(-1) ?? "") as Leftovers); return; } } catch { /* reported below */ }
    reject(new Error(`job leftovers on ${host.name}: ${(String(stderr) || String(stdout)).replace(/\s+/g, " ").trim().slice(0, 300) || error?.message || "no answer"}`));
  });
});

/**
 * `node --import tsx src/job-leftovers.ts end <session>[/sub-...] [session]` ends the leftovers of that folder under this box's ARTIFACTS, and
 * `deleted <chat>` those of the chat's deleted jobs; each prints the Leftovers as one JSON line. The process stays up for the SIGKILL pass and
 * the second strays read (`stopProcesses`, `endLeftovers`), which the service's unref'd timers would drop here.
 */
async function main(args: readonly string[]): Promise<void> {
  const [kind, path, session] = args;
  const source: LeftoverSource = { ...leftoverSource, later: (ms, run) => { setTimeout(run, ms); } };
  let left: Leftovers;
  if (kind === "end" && path && ARTIFACT_PATH.test(path) && (session === undefined || SESSION.test(session))) left = await endLeftovers(source, join(ARTIFACTS, path), session);
  else if (kind === "deleted" && path && SESSION.test(path)) left = await endLeftovers(source, await deletedFolders(join(ARTIFACTS, path)));
  else throw new Error("usage: job-leftovers.ts end <session>[/sub-...] [session] | deleted <chat>");
  process.stdout.write(JSON.stringify(left) + "\n");
}

if (process.argv[1] && isAbsolute(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
