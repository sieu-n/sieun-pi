import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WIKI_CONTENT_DIR } from "./chat-wiki.ts";
import type { RawProcess } from "./mac-usable-watch.ts";

/**
 * What a job leaves behind once it is gone, and the stop of it. On 10-15 at 00:45Z a deleted job's nohup'd runner.py went on to start a 30 GB
 * script, and on 10-16 at 01:40Z two `message-limit-check.py wait-start` waiters of a chat whose kernel had died still ran, and the Aside
 * browser held tabs whose jobs were gone; the delete notice only named the processes and asked the chat to stop them. Now the service stops them
 * itself: every process that carries the RLM_HARNESS_STATE_DIR of the job's session or of a session under it (its subagents) and sits under no
 * kernel and no Prime process (worker-footprint.py `strays`), and every Aside tab those sessions opened (`aside-browser-tabs.json` in their
 * session folders). Shared services (PM2, Aside, cua-driver) and Prime's own processes are never named, so ops guy's pm2 dev servers stay.
 * It also deletes the repo copies a job left in its wiki session folders, the /tmp trees it made and the repo copies in the ~/scratch trees it made, after stopping the rig processes in them,
 * and the kernel-state.dill files and repo copies its sessions left in session-artifacts.
 */

export const ARTIFACTS = join(homedir(), ".prime", "agent", "session-artifacts");
const HELPER = new URL("./worker-footprint.py", import.meta.url).pathname;
/** SIGTERM first, then SIGKILL after this long if the same process still runs (the owner's 10-15 ask: "SIGTERM, then SIGKILL after 10 s"). */
export const KILL_AFTER_MS = 10_000;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const TABS_FILE = "aside-browser-tabs.json";

export interface Leftovers { stopped: readonly RawProcess[]; tabs: number; copies: readonly string[]; tmp: readonly string[]; artifacts: readonly string[] }
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
  /** The /tmp trees the sessions of these transcripts made and the repo copies in their ~/scratch trees (`madeTmpTrees`, `scratchCopies`); `dirs` are the gone sessions' folders. */
  tmpTrees: (transcripts: readonly string[], dirs: readonly string[]) => Promise<readonly string[]>;
  /** The processes that run in or hold these dirs (worker-footprint.py `--inside`). */
  inside: (dirs: readonly string[]) => Promise<readonly InsideProcess[]>;
  /** Deletes these dirs; returns the ones it deleted. */
  removeTmp: (dirs: readonly string[]) => Promise<readonly string[]>;
  /** The repo copies the sessions of these transcripts left in session-artifacts (`artifactCopies`); `dirs` are the gone sessions' folders. */
  artifactCopies: (transcripts: readonly string[], dirs: readonly string[]) => Promise<readonly string[]>;
  /** The kernel-state.dill files of the sessions of these transcripts (`kernelStates`). */
  kernelStates: (transcripts: readonly string[]) => Promise<readonly string[]>;
}

/** The session ids, transcripts, Aside tab ids and tab record files of a session folder and every folder under it (its subagents). */
export async function sessionTree(dir: string): Promise<{ sessions: string[]; transcripts: string[]; tabs: string[]; tabFiles: string[] }> {
  const sessions: string[] = [];
  const transcripts: string[] = [];
  const tabs: string[] = [];
  const tabFiles: string[] = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (SESSION_FILE.test(entry.name)) {
      sessions.push(entry.name.slice(0, -".jsonl".length));
      transcripts.push(join(entry.parentPath, entry.name));
    }
    else if (entry.name === TABS_FILE) {
      const file = join(entry.parentPath, entry.name);
      const record = await readFile(file, "utf8").then(text => JSON.parse(text) as { tabs?: unknown }, () => null);
      const ids = record && typeof record.tabs === "object" && record.tabs ? Object.keys(record.tabs) : [];
      if (ids.length) { tabs.push(...ids); tabFiles.push(file); }
    }
  }
  return { sessions, transcripts, tabs, tabFiles };
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

/**
 * What a job's end deletes in the ~/scratch trees a gone job made (`madeScratchTrees`): the repo copies below each tree (`repoCopies`), and the
 * folders of a tree that is a repo copy itself, so the reports, logs and run output a job keeps beside them stay. On 10-19 at 01:27Z and 01:53Z
 * the sweep of deleted jobs deleted ~/scratch/retire-2547, release-fold and saved-session-archive whole, minutes after chat 01a14210 had read
 * their EVIDENCE.md, PASS.md and calls.jsonl, and the evidence of three finished jobs was lost. Of ~/scratch's 30.5 GB at 02:16Z, 15.5 GB sat in
 * the repo copies this finds.
 */
export async function scratchCopies(trees: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const tree of trees) {
    if (!await isRepoCopy(tree)) { found.push(...await repoCopies(tree)); continue; }
    for (const entry of await readdir(tree, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) found.push(join(tree, entry.name));
  }
  return found;
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
const TMP_NAME = "[A-Za-z0-9._+@-]+";

function escaped(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * A transcript without its tool results: what the session wrote or was told (its briefs, code, commands and messages). A path that shows only
 * in a result, such as an `ls /tmp` listing, was made by someone else as often as by the session.
 */
async function ownLines(file: string): Promise<string> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.includes(TOOL_RESULT) ? text.split("\n").filter(line => !line.includes(TOOL_RESULT)).join("\n") : text;
}
const TOOL_RESULT = '"role":"toolResult"';

/**
 * The top-level entries of `root` (/tmp, a tmpfs, so each byte is RAM or swap) the sessions of these transcripts made: a transcript names it
 * outside its tool results (`ownLines`), our user owns it, it was born after that session's first line and last changed before the session's
 * file did, so an entry that was there before the job, or one a later job made or wrote under a reused name, stays. A tree that a session
 * still live in the same chat names (a sibling job briefed to take over a rig) stays too; the chat and the jobs above a gone job are left out
 * of that read, because they quote its report. On 10-18 at 12:5xZ us-metal02's /tmp held 32.6 GB with swap full: 14 p8iso Prime rigs of
 * about 1 GB each and 6 GB of repo clones from gone jobs.
 */
export async function madeTmpTrees(transcripts: readonly string[], dirs: readonly string[], root = "/tmp", artifacts = ARTIFACTS): Promise<string[]> {
  return madeTrees(transcripts, dirs, root, new RegExp(`(?<![\\w./-])${escaped(root)}/(${TMP_NAME})`, "g"), artifacts, path => path, false);
}

export const SCRATCH = join(homedir(), "scratch");

/**
 * The top-level entries of ~/scratch the sessions of these transcripts made, by the rule of `madeTmpTrees`. The job line puts a job's repo trees
 * under ~/scratch/<job>/, and transcripts write that path from `~`, `$HOME`, `/home/<user>` or `/Users/<user>`, so a live session's naming is
 * matched by its `/scratch/<name>` part. On 10-18 between 16:04Z and 16:34Z jobs on us-metal02 added 7.5 GB of scratch trees, 0.66 GB per
 * `git archive` export, and ~/scratch held 60 GB, most of it trees of jobs that had ended.
 */
export async function madeScratchTrees(transcripts: readonly string[], dirs: readonly string[], root = SCRATCH, artifacts = ARTIFACTS): Promise<string[]> {
  const named = new RegExp(`(?<![\\w./-])(?:~|\\$HOME|/home/[\\w.-]+|/Users/[\\w.-]+)/scratch/(${TMP_NAME})`, "g");
  return madeTrees(transcripts, dirs, root, named, artifacts, path => `/scratch/${path.slice(root.length + 1)}`, true);
}

/**
 * Whether anything at or below `path` changed after `since` or was born before `start` (epoch ms): a later write is another session's work, and
 * an older entry was moved in from elsewhere, since a `git archive` export, a clone or a copy makes new inodes. A file with more than one link
 * (a pnpm store hardlink in node_modules) keeps its store birth, so only its change time counts. A symlink is read as itself, never followed.
 */
async function heldElsewhere(path: string, start: number, since: number): Promise<boolean> {
  const item = await lstat(path).catch(() => null);
  if (!item) return false;
  if (item.mtimeMs > since) return true;
  if (item.birthtimeMs > 0 && item.birthtimeMs < start && (item.isDirectory() || item.nlink === 1)) return true;
  if (!item.isDirectory()) return false;
  for (const entry of await readdir(path).catch(() => [])) if (await heldElsewhere(join(path, entry), start, since)) return true;
  return false;
}

/**
 * The entries of `root` that `named` finds in a gone session's own lines, born after its first line, and unchanged since its file last changed:
 * the entry itself, or with `deep` anything under it (`heldElsewhere`), so a scratch tree another live session still writes in stays (on
 * 10-18 at 16:44Z an earlier disk job deleted ~/scratch/disk-growth-p9 by hand while the next disk job, in another chat, still wrote its file
 * lists there), and so does one that holds what a job moved in from elsewhere (at 12:31Z on 10-18 a cleanup job moved 116 repo copies, 9.6 GB,
 * out of wiki session folders into ~/scratch/session-copies-1018 because their writers were still live).
 */
async function madeTrees(transcripts: readonly string[], dirs: readonly string[], root: string, named: RegExp, artifacts: string,
  needle: (path: string) => string, deep: boolean): Promise<string[]> {
  const uid = process.getuid?.();
  const made = new Set<string>();
  for (const file of transcripts) {
    const [text, info] = await Promise.all([ownLines(file), stat(file).catch(() => null)]);
    let start = NaN;
    try { start = Date.parse((JSON.parse(text.slice(0, text.indexOf("\n"))) as { timestamp?: string }).timestamp ?? ""); } catch { /* no header */ }
    if (!info || !Number.isFinite(start)) continue;
    for (const entry of new Set([...text.matchAll(named)].map(match => match[1]!))) {
      const path = join(root, entry);
      if (made.has(path) || SHARED_TMP.test(entry) || /^\.+$/.test(entry)) continue;
      const item = await lstat(path).catch(() => null);
      if (!item || item.isSymbolicLink() || (uid !== undefined && item.uid !== uid)) continue;
      if (item.birthtimeMs > 0 && item.birthtimeMs >= start && item.mtimeMs <= info.mtimeMs && !(deep && await heldElsewhere(path, start, info.mtimeMs))) made.add(path);
    }
  }
  return unnamedByLive(made, transcripts, dirs, artifacts, needle);
}

/**
 * The paths of `made` that no session still live in the same chat names (`needle` of the path) outside its tool results. The chat and the jobs above a gone job are
 * left out of that read, because they quote its report.
 */
async function unnamedByLive(made: Set<string>, transcripts: readonly string[], dirs: readonly string[], artifacts: string,
  needle = (path: string): string => path): Promise<string[]> {
  if (!made.size) return [];
  const ended = new Set(transcripts);
  const above = (folder: string): boolean => dirs.some(dir => dir.startsWith(folder + "/"));
  const tops = new Set(dirs.filter(dir => dir.startsWith(artifacts + "/")).map(dir => join(artifacts, dir.slice(artifacts.length + 1).split("/")[0]!)));
  for (const top of tops) {
    const gone = await deletedFolders(top);
    const live = (await sessionTree(top)).transcripts.filter(file => !ended.has(file) && !above(dirname(file)) && !gone.some(dir => file.startsWith(dir + "/")));
    for (const file of live) {
      if (!made.size) break;
      const text = await ownLines(file);
      for (const path of made) if (new RegExp(`${escaped(needle(path))}(?![A-Za-z0-9._+@-])`).test(text)) made.delete(path);
    }
  }
  return [...made];
}

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
 * The repo copies (`repoCopies`) gone sessions left in ~/.prime/agent/session-artifacts: those in the sessions' own folders, and those in a named
 * folder of session-artifacts that a transcript names outside its tool results and that were born while that session ran, minus a copy a live
 * session in the same chat names by its `.prime/agent/session-artifacts/` path, since transcripts write it from `~`, `/home/<user>` or `/Users/<user>`. On 10-18 between 02:30Z and 16:12Z session-artifacts grew 10.6 GB on us-metal02, 4.5 GB of it five
 * `git archive` trees in grafana-c that a grafana job exported to test merged trees.
 */
export async function artifactCopies(transcripts: readonly string[], dirs: readonly string[], artifacts = ARTIFACTS): Promise<string[]> {
  const found = new Set<string>();
  const made = new Set<string>();
  const named = /\.prime\/agent\/session-artifacts\/([A-Za-z0-9._+@-]+)/g;
  const uid = process.getuid?.();
  for (const file of transcripts) {
    for (const copy of await repoCopies(dirname(file))) found.add(copy);
    const [text, info] = await Promise.all([ownLines(file), stat(file).catch(() => null)]);
    let start = NaN;
    try { start = Date.parse((JSON.parse(text.slice(0, text.indexOf("\n"))) as { timestamp?: string }).timestamp ?? ""); } catch { /* no header */ }
    if (!info || !Number.isFinite(start)) continue;
    for (const name of new Set([...text.matchAll(named)].map(match => match[1]!))) {
      if (SESSION_DIR.test(name) || /^\.+$/.test(name)) continue;
      const folder = await lstat(join(artifacts, name)).catch(() => null);
      if (!folder?.isDirectory() || (uid !== undefined && folder.uid !== uid)) continue;
      for (const copy of await repoCopies(join(artifacts, name))) {
        const item = await lstat(copy).catch(() => null);
        if (item && item.birthtimeMs > 0 && item.birthtimeMs >= start && item.mtimeMs <= info.mtimeMs) made.add(copy);
      }
    }
  }
  const relative = (copy: string): string => `.prime/agent/session-artifacts/${copy.slice(artifacts.length + 1)}`;
  for (const copy of await unnamedByLive(made, transcripts, dirs, artifacts, relative)) found.add(copy);
  return [...found];
}

/**
 * Ends the /tmp trees gone sessions made (`madeTmpTrees`): the processes that run in one (a rig's daemon with its home there, its fake model,
 * a vite in a clone) get SIGTERM, then the tree is deleted. A tree that a shared service, a Prime process outside the rig or a process of a
 * session still live uses is kept whole. On 10-18 a p8iso rig's units outlived the job's own teardown and held 10.9 GiB, and its processes
 * carried no RLM_HARNESS_STATE_DIR (systemd-run starts them with a clean environment), so `strays` never saw them.
 */
async function endTmp(source: LeftoverSource, transcripts: readonly string[], dirs: readonly string[], sessions: readonly string[]): Promise<{ stopped: RawProcess[]; removed: readonly string[] }> {
  const trees = await source.tmpTrees(transcripts, dirs);
  if (!trees.length) return { stopped: [], removed: [] };
  const using = await source.inside(trees);
  const ended = new Set(sessions);
  const held = new Set(using.filter(entry => entry.shared || (entry.prime && entry.session === null) || (entry.session !== null && !ended.has(entry.session))).map(entry => entry.dir));
  const free = trees.filter(dir => !held.has(dir));
  const rig = new Map(using.filter(entry => !entry.prime && free.includes(entry.dir)).map(entry => [entry.pid, entry]));
  const stopped = await stopProcesses(source, [...rig.values()]);
  return { stopped, removed: free.length ? await source.removeTmp(free) : [] };
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
 * open Aside for them again, deletes the repo copies they left in the wiki session folders they opened, and ends the /tmp trees they made
 * (`endTmp`), and deletes the kernel states and repo copies they left in session-artifacts (`endArtifacts`). With `session`, the processes are read again after KILL_AFTER_MS, since a kernel the daemon is still ending at the
 * delete leaves its children detached only once it exits.
 */
export async function endLeftovers(source: LeftoverSource, dirs: string | readonly string[], session?: string): Promise<Leftovers> {
  const trees = await Promise.all((typeof dirs === "string" ? [dirs] : dirs).map(sessionTree));
  const sessions = [...new Set([...(session ? [session] : []), ...trees.flatMap(tree => tree.sessions)])];
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
  const tmp = await endTmp(source, transcripts, typeof dirs === "string" ? [dirs] : dirs, sessions).catch(() => ({ stopped: [], removed: [] }));
  const artifacts = await endArtifacts(source, transcripts, typeof dirs === "string" ? [dirs] : dirs).catch(() => []);
  return { stopped: [...stopped, ...tmp.stopped], tabs: Math.max(tabs, 0), copies, tmp: tmp.removed, artifacts };
}

/** Deletes the kernel-state.dill files and the repo copies gone sessions left in session-artifacts, and keeps a copy any process runs in or holds. */
async function endArtifacts(source: LeftoverSource, transcripts: readonly string[], dirs: readonly string[]): Promise<readonly string[]> {
  const [copies, states] = await Promise.all([source.artifactCopies(transcripts, dirs), source.kernelStates(transcripts)]);
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

/** Transcripts whose wiki session folders, /tmp trees and session-artifacts copies were already cleared, so the sweep of deleted jobs reads each transcript once. */
const copiesCleared = new Set<string>();
const tmpCleared = new Set<string>();
const artifactsCleared = new Set<string>();

/** The real source: the footprint helper, process.kill, `aside repl`, timers that do not hold the service open, `removeRepoCopies`, `madeTmpTrees` and `madeScratchTrees`. */
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
  tmpTrees: (transcripts, dirs) => {
    const fresh = transcripts.filter(file => !tmpCleared.has(file));
    for (const file of fresh) tmpCleared.add(file);
    return fresh.length ? Promise.all([madeTmpTrees(fresh, dirs), madeScratchTrees(fresh, dirs).then(scratchCopies)]).then(found => found.flat()) : Promise.resolve([]);
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
  artifactCopies: (transcripts, dirs) => {
    const fresh = transcripts.filter(file => !artifactsCleared.has(file));
    for (const file of fresh) artifactsCleared.add(file);
    return fresh.length ? artifactCopies(fresh, dirs) : Promise.resolve([]);
  },
  kernelStates: transcripts => kernelStates(transcripts),
};

/** A replay serve's source (`serve --replay-daemon`): the same reads, with no kill, tab close or delete, and a tab count of -1 so no tab record is emptied. */
export const dryLeftoverSource: LeftoverSource = { ...leftoverSource, kill: () => {}, closeTabs: async () => -1, removeCopies: async () => [], removeTmp: async () => [] };
