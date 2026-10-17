import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

export interface Leftovers { stopped: readonly RawProcess[]; tabs: number }
export interface LeftoverSource {
  /** The detached processes of these sessions (worker-footprint.py `--session`). */
  strays: (sessions: readonly string[]) => Promise<readonly RawProcess[]>;
  /** A process's start time in epoch seconds, null when it is gone. */
  started: (pid: number) => Promise<number | null>;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Closes the Aside tabs among these target ids that are still open; returns how many it closed. */
  closeTabs: (ids: readonly string[]) => Promise<number>;
  later: (ms: number, run: () => void) => void;
}

/** The session ids, Aside tab ids and tab record files of a session folder and every folder under it (its subagents). */
export async function sessionTree(dir: string): Promise<{ sessions: string[]; tabs: string[]; tabFiles: string[] }> {
  const sessions: string[] = [];
  const tabs: string[] = [];
  const tabFiles: string[] = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (SESSION_FILE.test(entry.name)) sessions.push(entry.name.slice(0, -".jsonl".length));
    else if (entry.name === TABS_FILE) {
      const file = join(entry.parentPath, entry.name);
      const record = await readFile(file, "utf8").then(text => JSON.parse(text) as { tabs?: unknown }, () => null);
      const ids = record && typeof record.tabs === "object" && record.tabs ? Object.keys(record.tabs) : [];
      if (ids.length) { tabs.push(...ids); tabFiles.push(file); }
    }
  }
  return { sessions, tabs, tabFiles };
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
 * open Aside for them again. With `session`, the processes are read again after KILL_AFTER_MS, since a kernel the daemon is still ending at the
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
  return { stopped, tabs: Math.max(tabs, 0) };
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
 * no longer shows. closeTab closes only a tab its own REPL session opened; from another session it only lets the tab go (tried 10-16 01:5xZ
 * through both `aside repl` and `aside mcp`, and the tab stayed open), and a gone job's session is gone.
 */
export function closeAsideTabs(ids: readonly string[], cli = process.env.ASIDE_CLI ?? join(homedir(), ".local", "bin", "aside")): Promise<number> {
  const code = `const __leftoverIds = ${JSON.stringify(ids)}; const __leftoverOpen = new Set((await listBrowserTabs()).map(tab => tab.targetId));
for (const id of __leftoverIds) if (__leftoverOpen.has(id)) { const tab = await attachBrowserTab(id); await tab.evaluate(() => window.close()).catch(() => {}); }
await sleep(500); const __leftoverLeft = new Set((await listBrowserTabs()).map(tab => tab.targetId));
console.log("LEFTOVER_CLOSED " + __leftoverIds.filter(id => __leftoverOpen.has(id) && !__leftoverLeft.has(id)).length);`;
  return new Promise((resolve, reject) => {
    execFile(cli, ["repl", code], { timeout: 130_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const closed = /LEFTOVER_CLOSED (\d+)/.exec(stdout);
      if (closed) resolve(Number(closed[1]));
      else reject(error ?? new Error(`aside repl: ${(stdout + stderr).slice(0, 300)}`));
    });
  });
}

/** The real source: the footprint helper, process.kill, `aside repl` and timers that do not hold the service open. */
export const leftoverSource: LeftoverSource = {
  strays: async sessions => {
    const answer = await helper(["--session", sessions.join(",")]) as { strays?: RawProcess[] };
    return Array.isArray(answer?.strays) ? answer.strays : [];
  },
  started: async pid => { const answer = await helper(["--started", String(pid)]); return typeof answer === "number" ? answer : null; },
  kill: (pid, signal) => { process.kill(pid, signal); },
  closeTabs: ids => closeAsideTabs(ids),
  later: (ms, run) => { setTimeout(run, ms).unref(); },
};
