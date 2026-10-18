import { open, readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { SessionSummary } from "prime-agent";
import { subagentFolder } from "./chat-catalog.ts";
import { DutyStore } from "./chat-duty-store.ts";
import { IdIndex } from "./id-index.ts";
import { missing, snapshotJsonFile, type JsonFile } from "./locked-json.ts";
import { PROMPTS_DIR } from "./prompt-capture.ts";

/** Once a day, from the owner's ask on 10-16 ("once a day, the chat service deletes the prompt file of every session that is archived or deleted"). */
export const PROMPT_PRUNE_EVERY_MS = 24 * 60 * 60_000;

/** Why the prune deletes a file in `<dataDir>/prompts`. */
export type PruneReason = "archived chat" | "archived thread" | "deleted job" | "no session file" | "unreadable" | "stale temp file";

export interface PruneResult {
  deleted: { name: string; bytes: number; reason: PruneReason }[];
  kept: { files: number; bytes: number; dutyRuns: number };
}

export interface PromptPruneSource {
  dataDir: string;
  /** The Prime agent dir; its `session-artifacts` holds every subagent's folder under its parent's. */
  agentDir: string;
  /** The daemon's session rows, subagents included (`Catalog.daemonRows`). A rejection or no rows drops the archived-thread and unlisted-subagent checks from this run. */
  rows: () => Promise<readonly SessionSummary[]>;
  log: (line: string) => void;
  fileExists?: (path: string) => boolean;
  pidAlive?: (pid: number) => boolean;
}

/** The session id and session file at the start of a capture, which `recordPrompt` writes first; the whole file is parsed only when they are not there. */
const HEAD = /^\{"capturedAt":"[^"]*","sessionId":("(?:[^"\\]|\\.)*"),"sessionFile":(null|"(?:[^"\\]|\\.)*")/;
const HEAD_BYTES = 4096;
const TEMP = /\.json\.(\d+)\.\d+\.tmp$/;

async function captureHead(path: string): Promise<{ sessionId: string; sessionFile: string | null } | null> {
  const handle = await open(path, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
  const match = HEAD.exec(text);
  if (match) return { sessionId: JSON.parse(match[1]!) as string, sessionFile: JSON.parse(match[2]!) as string | null };
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { sessionId?: unknown; sessionFile?: unknown };
    if (typeof value.sessionId !== "string") return null;
    return { sessionId: value.sessionId, sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : null };
  } catch { return null; }
}

/** A session's own artifacts folder: a subagent's session file sits in it, a top-level session's is `session-artifacts/<id>` next to `sessions/`. */
function ownFolder(sessionId: string, sessionFile: string): string {
  return sessionFile.includes(`${sep}session-artifacts${sep}`) ? dirname(sessionFile) : join(dirname(dirname(sessionFile)), "session-artifacts", sessionId);
}

const deletedJobsFile = (dataDir: string): JsonFile<Record<string, Record<string, number>>> => ({ path: join(dataDir, "deleted-jobs.json"), label: "Deleted job record",
  initial: () => ({}), parse: value => typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Record<string, number>] => typeof entry[1] === "object" && entry[1] !== null)) : {} });

/** The job of each duty's newest run that started one, check-ins included, per chat (`<dataDir>/duties/<chat>.runs.jsonl`). */
async function newestDutyJobs(dataDir: string): Promise<Set<string>> {
  const store = new DutyStore(dataDir);
  const keep = new Set<string>();
  for (const chat of await store.chats()) {
    const seen = new Set<string>();
    for (const run of await store.runs(chat)) {
      if (!run.job || seen.has(run.duty)) continue;
      seen.add(run.duty);
      keep.add(run.job.id);
    }
  }
  return keep;
}

const defaultPidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/**
 * Deletes the prompt capture (src/prompt-capture.ts) of every session that ended: a chat the owner archived (`archived-chats.json`), a thread
 * the daemon lists as archived, a job the cleanup deleted (`deleted-jobs.json`), a subagent the daemon no longer lists (`rlm.delete_subagent`
 * drops it from the list and leaves its folder), a session whose file is gone, and every subagent below one of them, found by its session
 * file's place under the ended session's artifacts folder. The newest started run of each duty keeps its job's
 * file even when that job is archived, so the latest run stays viewable until the next one starts. Temp files of a writer that is gone go too.
 * Every run decides from the files and records as they are now, so a run that stopped halfway leaves files the next run deletes.
 */
export async function prunePrompts(source: PromptPruneSource): Promise<PruneResult> {
  const fileExists = source.fileExists ?? existsSync;
  const pidAlive = source.pidAlive ?? defaultPidAlive;
  const dir = join(source.dataDir, PROMPTS_DIR);
  const artifacts = join(source.agentDir, "session-artifacts");
  const result: PruneResult = { deleted: [], kept: { files: 0, bytes: 0, dutyRuns: 0 } };
  let names: string[];
  try { names = await readdir(dir); } catch (error) { if (missing(error)) return result; throw error; }
  const ended = new Map<string, PruneReason>();
  for (const chat of await new IdIndex(join(source.dataDir, "archived-chats.json"), "Archived chat index").ids()) ended.set(join(artifacts, chat), "archived chat");
  for (const [chat, jobs] of Object.entries(await snapshotJsonFile(deletedJobsFile(source.dataDir)))) {
    for (const child of Object.keys(jobs)) ended.set(join(artifacts, chat, child), "deleted job");
  }
  let listed: Set<string> | null = null;
  try {
    const rows = await source.rows();
    if (rows.length) listed = new Set(rows.map(row => row.sessionId));
    for (const row of rows) {
      if (row.lifecycle !== "archived") continue;
      const folder = subagentFolder(row);
      if (folder && !ended.has(folder)) ended.set(folder, "archived thread");
    }
  } catch (error) { source.log(`prompt prune: no daemon list, archived threads wait for the next run: ${error instanceof Error ? error.message : String(error)}`); }
  const dutyJobs = await newestDutyJobs(source.dataDir);
  const reasonFor = (sessionId: string, sessionFile: string | null): PruneReason | null => {
    if (!sessionFile || !fileExists(sessionFile)) return "no session file";
    for (let folder = ownFolder(sessionId, sessionFile); folder.startsWith(artifacts + sep); folder = dirname(folder)) {
      const reason = ended.get(folder);
      if (reason) return reason;
    }
    return listed && sessionFile.includes(`${sep}session-artifacts${sep}`) && !listed.has(sessionId) ? "deleted job" : null;
  };
  for (const name of names) {
    const path = join(dir, name);
    const size = await stat(path).then(info => info.isFile() ? info.size : null, () => null);
    if (size === null) continue;
    let reason: PruneReason | null = null;
    const temp = TEMP.exec(name);
    if (temp) {
      if (!pidAlive(Number(temp[1]))) reason = "stale temp file";
    } else if (name.endsWith(".json")) {
      const head = await captureHead(path).catch(() => null);
      if (!head) reason = "unreadable";
      else if (dutyJobs.has(head.sessionId)) result.kept.dutyRuns++;
      else reason = reasonFor(head.sessionId, head.sessionFile);
    }
    if (!reason) { result.kept.files++; result.kept.bytes += size; continue; }
    await rm(path, { force: true });
    result.deleted.push({ name, bytes: size, reason });
  }
  return result;
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

export function pruneSummary(result: PruneResult): string {
  const byReason = new Map<PruneReason, { files: number; bytes: number }>();
  for (const entry of result.deleted) {
    const total = byReason.get(entry.reason) ?? { files: 0, bytes: 0 };
    total.files++; total.bytes += entry.bytes;
    byReason.set(entry.reason, total);
  }
  const bytes = result.deleted.reduce((sum, entry) => sum + entry.bytes, 0);
  const reasons = [...byReason].map(([reason, total]) => `${reason} ${total.files} (${mb(total.bytes)} MB)`).join(", ");
  return `prompt prune: deleted ${result.deleted.length} files, ${mb(bytes)} MB${reasons ? ` (${reasons})` : ""}; kept ${result.kept.files} files, ` +
    `${mb(result.kept.bytes)} MB, ${result.kept.dutyRuns} of them a duty's newest run`;
}

/** Runs the prune now and every PROMPT_PRUNE_EVERY_MS, one run at a time, and logs each run's counts; the returned function stops the timer. */
export function startPromptPrune(source: PromptPruneSource, everyMs = PROMPT_PRUNE_EVERY_MS): () => void {
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    void prunePrompts(source).then(result => source.log(pruneSummary(result)),
      error => source.log(`prompt prune: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false; });
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
