import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WIKI_CONTENT_DIR } from "./chat-wiki.ts";
import type { RawProcess } from "./mac-usable-watch.ts";

/**
 * What a job leaves behind once it is gone, and the stop of it. On 10-15 at 00:45Z a deleted job's nohup'd runner.py went on to start a 30 GB
 * script, and on 10-16 at 01:40Z two `message-limit-check.py wait-start` waiters of a chat whose kernel had died still ran, and the Aside
 * browser held tabs whose jobs were gone; the delete notice only named the processes and asked the chat to stop them. Now the service stops them
 * itself: every process that carries the RLM_HARNESS_STATE_DIR of the job's session or of a session under it (its subagents) and sits under no
 * kernel and no Prime process (worker-footprint.py `strays`), and every Aside tab those sessions opened (`aside-browser-tabs.json` in their
 * session folders). Shared services (PM2, Aside, cua-driver) and Prime's own processes are never named, so ops guy's pm2 dev servers stay.
 */

export const ARTIFACTS = join(homedir(), ".prime", "agent", "session-artifacts");
const HELPER = new URL("./worker-footprint.py", import.meta.url).pathname;
/** SIGTERM first, then SIGKILL after this long if the same process still runs (the owner's 10-15 ask: "SIGTERM, then SIGKILL after 10 s"). */
export const KILL_AFTER_MS = 10_000;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const TABS_FILE = "aside-browser-tabs.json";

export interface Leftovers { stopped: readonly RawProcess[]; tabs: number; copies: readonly string[] }
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
 * `git archive` export), and each `node_modules`. On 10-18 the session folders held 502 such copies with 1.3M of their 1.7M files, and the wiki
 * index, `git status` and every walker paid for them.
 */
export async function repoCopies(folder: string): Promise<string[]> {
  const copies: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === "node_modules") { copies.push(path); continue; }
      const inside = await readdir(path, { withFileTypes: true }).catch(() => []);
      const copy = inside.some(item => item.name === ".git" || item.name === "pnpm-workspace.yaml" ||
        (item.name === "scripts" && item.isDirectory() && existsSync(join(path, "scripts", "repo"))));
      if (copy) copies.push(path);
      else await walk(path);
    }
  };
  await walk(folder);
  return copies;
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

/** SIGTERM to each process whose start time still matches, then SIGKILL after KILL_AFTER_MS to each one still running with that start time. */
async function stop(source: LeftoverSource, found: readonly RawProcess[]): Promise<RawProcess[]> {
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
 * open Aside for them again, and deletes the repo copies they left in the wiki session folders they opened. With `session`, the processes are read again after KILL_AFTER_MS, since a kernel the daemon is still ending at the
 * delete leaves its children detached only once it exits.
 */
export async function endLeftovers(source: LeftoverSource, dirs: string | readonly string[], session?: string): Promise<Leftovers> {
  const trees = await Promise.all((typeof dirs === "string" ? [dirs] : dirs).map(sessionTree));
  const sessions = [...new Set([...(session ? [session] : []), ...trees.flatMap(tree => tree.sessions)])];
  const stopped = sessions.length ? await stop(source, await source.strays(sessions)) : [];
  if (session) source.later(KILL_AFTER_MS, () => { void source.strays(sessions).then(found => stop(source, found)).catch(() => []); });
  const ids = trees.flatMap(tree => tree.tabs);
  const tabs = ids.length ? await source.closeTabs(ids).catch(() => -1) : 0;
  if (tabs >= 0) for (const file of trees.flatMap(tree => tree.tabFiles)) {
    const record = await readFile(file, "utf8").then(text => JSON.parse(text) as Record<string, unknown>, () => null);
    if (record) await writeFile(file, JSON.stringify({ ...record, tabs: {} })).catch(() => {});
  }
  const copies = await source.removeCopies(trees.flatMap(tree => tree.transcripts)).catch(() => []);
  return { stopped, tabs: Math.max(tabs, 0), copies };
}

function helper(args: readonly string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/python3", ["-B", HELPER, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout) as unknown); } catch (failure) { reject(failure); }
    });
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

/** Transcripts whose wiki session folders were already cleared, so the sweep of deleted jobs reads each transcript once. */
const copiesCleared = new Set<string>();

/** The real source: the footprint helper, process.kill, `aside repl`, timers that do not hold the service open, and `removeRepoCopies`. */
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
};
