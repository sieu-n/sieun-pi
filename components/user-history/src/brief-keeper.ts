import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zTime } from "./checkin-goals.ts";
import type { JobFact } from "./checkin-steps.ts";
import { sessionBrief } from "./job-resume.ts";

/**
 * The brief of every job a chat or its jobs start, kept until the job's session shows it. Prime holds a new session's first prompt in its
 * worker's memory until the first turn starts; only then does it reach the session file. At 23:43 to 00:04Z on 10-15/16, ten children in three
 * trees (Crawler VP's "opensearch disk move" at 23:58:30Z and "post reads schema fix" at 00:03:27Z among them) were admitted, got their session
 * file with its 5 header lines, and waited 17 to 37 min with no first prompt; the supervisor restart at 00:20:13Z took the waiting prompts with
 * it. The check-in then read both jobs as working or idle. The kernel wrapper (message-limit-check.py) writes each spawn's brief to
 * `<data dir>/spawn-briefs/` as rlm.spawn or rlm.create_session returns, so the brief no longer lives only in that memory. This sends a brief
 * whose session still has none after BRIEF_LATE_MS, and sends it again once the daemon restarted after the last send, which drops it again.
 * A record goes once its session holds a first prompt or its child was deleted or cancelled.
 */

export const BRIEFS_DIR = "spawn-briefs";
/**
 * A session with no first prompt this long after its spawn has lost it or is stuck. Of 1,976 child sessions started from 10-13 to 10-16 05:30Z
 * the first prompt landed within 274 s at p99 (p50 3 s, p90 33 s); of 1,662 roots, within 189 s at p99.
 */
export const BRIEF_LATE_MS = 5 * 60_000;
/** The keeper reads the records on the wakes' 30 s tick (wakes.ts TICK_MS). */
export const BRIEF_TICK_MS = 30_000;

/** One spawn the kernel wrapper recorded: a child from rlm.spawn (its RLM child id) or a root from rlm.create_session (its session id). */
export interface BriefRecord {
  kind: "child" | "root";
  id: string;
  name: string;
  prompt: string;
  /** Epoch ms when the spawn returned. */
  at: number;
  /** The root session of its tree, which `startRoot` loads when the daemon no longer finds the session. */
  root: string;
  /** A child's folder (`<root artifacts>/sub-<id>`), where Prime writes its rlm-subagent.json and session file. */
  sessionDir?: string;
  /** A root's session file, from rlm.create_session. */
  sessionFile?: string;
  /** The keeper's last send: when, and the daemon it went to (`daemonEpoch`). */
  sent?: { at: number; daemon: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const ID = /^[\w-]{1,128}$/;
/** A record file's content, parsed at the boundary; null when it is not one. */
export function parseBriefRecord(value: unknown): BriefRecord | null {
  if (!isRecord(value) || (value.kind !== "child" && value.kind !== "root") || typeof value.id !== "string" || !ID.test(value.id)) return null;
  if (typeof value.prompt !== "string" || typeof value.at !== "number" || !Number.isFinite(value.at) || typeof value.root !== "string" || !ID.test(value.root)) return null;
  const sent = isRecord(value.sent) && typeof value.sent.at === "number" && typeof value.sent.daemon === "string" ? { sent: { at: value.sent.at, daemon: value.sent.daemon } } : {};
  return { kind: value.kind, id: value.id, name: typeof value.name === "string" ? value.name : "", prompt: value.prompt, at: value.at, root: value.root,
    ...(typeof value.sessionDir === "string" ? { sessionDir: value.sessionDir } : {}), ...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}), ...sent };
}

/** What the session of a record shows now: its session id and file once Prime wrote them, whether it holds a first prompt, and whether its child ended. */
export interface BriefSeen { sessionId?: string; file?: string; started: boolean; ended: boolean }

/** RLM child statuses after which nothing will start the child. */
const ENDED = new Set(["deleted", "cancelled", "error", "failed", "done"]);

/** Reads a record's session: a child's rlm-subagent.json (status, session file) else the one session file in its folder; a root's own file. */
export async function seeBrief(record: BriefRecord): Promise<BriefSeen> {
  let file = record.sessionFile;
  let ended = false;
  if (record.kind === "child" && record.sessionDir) {
    try {
      const spawn: unknown = JSON.parse(await readFile(join(record.sessionDir, "rlm-subagent.json"), "utf8"));
      if (isRecord(spawn)) {
        if (typeof spawn.sessionFile === "string") file = spawn.sessionFile;
        ended = typeof spawn.status === "string" && ENDED.has(spawn.status);
      }
    } catch { /* not written yet */ }
    if (!file) {
      const names = await readdir(record.sessionDir).catch(() => [] as string[]);
      const own = names.filter(name => name.endsWith(".jsonl") && name !== "semantic-edges.jsonl");
      if (own.length === 1) file = join(record.sessionDir, own[0]!);
    }
  }
  if (!file) return { started: false, ended };
  const sessionId = /([\w-]+)\.jsonl$/.exec(file)?.[1];
  const started = await sessionBrief(file).then(brief => brief !== undefined, () => false);
  return { ...(sessionId ? { sessionId } : {}), file, started, ended };
}

/** What the keeper does with one record this tick. */
export type BriefAct = { act: "drop"; why: "started" | "ended" } | { act: "wait" } | { act: "send"; session: string };

/**
 * The rule for one record: drop it once its session holds a first prompt or its child ended; else wait out BRIEF_LATE_MS from the spawn;
 * then send the brief to its session, once per daemon (`daemon`, the supervisor's socket identity), since a daemon restart drops a message
 * that waits in a worker the same way it dropped the first prompt. A session Prime has not written yet waits.
 */
export function briefAct(record: BriefRecord, seen: BriefSeen, daemon: string | undefined, now: number): BriefAct {
  if (seen.started) return { act: "drop", why: "started" };
  if (seen.ended) return { act: "drop", why: "ended" };
  if (now - record.at < BRIEF_LATE_MS || !seen.sessionId) return { act: "wait" };
  if (record.sent && (daemon === undefined || record.sent.daemon === daemon)) return { act: "wait" };
  return { act: "send", session: seen.sessionId };
}

/** The message that carries a lost brief: the brief as the parent wrote it, then one line on why it comes now. */
export function briefText(record: BriefRecord, now: number): string {
  const head = record.kind === "child" ? "[task from parent]\n\n" : "";
  return `${head}${record.prompt}\n\n(The chat service sent this brief at ${zTime(now)}: Prime started this session at ${zTime(record.at)} ` +
    "and its first prompt never reached it. If this brief already reached you, do it once.)";
}

/** The daemon supervisor's identity: its socket file's inode and birth time, which a supervisor start makes anew. Undefined when it cannot be read. */
export async function socketEpoch(socketPath: string): Promise<string | undefined> {
  const info = await stat(socketPath).catch(() => undefined);
  return info ? `${info.ino}:${Math.round(info.birthtimeMs)}` : undefined;
}

export interface BriefDeps {
  dir: string;
  /** Sends the session the text; resolves "gone" when the daemon knows no such session (wakes.ts). */
  deliver: (session: string, text: string) => Promise<"sent" | "gone">;
  /** Starts the worker of the tree `root`, so the daemon finds the session in it on the next tick (wakes.ts). */
  startRoot: (root: string) => Promise<void>;
  /** The identity of the running daemon supervisor; undefined when it cannot be read. */
  daemonEpoch: () => Promise<string | undefined>;
  log: (line: string) => void;
  now?: () => number;
  see?: (record: BriefRecord) => Promise<BriefSeen>;
}

async function readRecords(dir: string): Promise<{ file: string; record: BriefRecord }[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: { file: string; record: BriefRecord }[] = [];
  for (const name of names.filter(entry => entry.endsWith(".json"))) {
    const file = join(dir, name);
    const record = await readFile(file, "utf8").then(text => parseBriefRecord(JSON.parse(text)), () => null);
    if (record) out.push({ file, record });
  }
  return out;
}

async function writeRecord(file: string, record: BriefRecord): Promise<void> {
  await writeFile(`${file}.${process.pid}.tmp`, JSON.stringify(record), { mode: 0o600 });
  await rename(`${file}.${process.pid}.tmp`, file);
}

/** One pass over the records. Returns how many briefs went out. */
export async function briefTick(deps: BriefDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const see = deps.see ?? seeBrief;
  const daemon = await deps.daemonEpoch().catch(() => undefined);
  let sent = 0;
  for (const { file, record } of await readRecords(deps.dir)) {
    const act = briefAct(record, await see(record), daemon, now);
    const label = `${record.kind} ${record.name || record.id} (${record.id.slice(0, 12)})`;
    if (act.act === "drop") {
      await rm(file, { force: true });
      if (record.sent) deps.log(`briefs: ${label} ${act.why === "started" ? "has its first prompt now" : "ended"}; record dropped`);
      continue;
    }
    if (act.act === "wait") continue;
    try {
      const result = await deps.deliver(act.session, briefText(record, now));
      if (result === "gone") {
        deps.log(`briefs: ${label} has no first prompt ${Math.round((now - record.at) / 60_000)} min after its spawn and the daemon does not find it; starting its tree ${record.root.slice(0, 8)}`);
        await deps.startRoot(record.root);
        continue;
      }
      await writeRecord(file, { ...record, sent: { at: now, daemon: daemon ?? "" } });
      sent++;
      deps.log(`briefs: ${label} had no first prompt ${Math.round((now - record.at) / 60_000)} min after its spawn; sent its brief to ${act.session.slice(0, 8)}`);
    } catch (error) {
      deps.log(`briefs: ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sent;
}

export function startBriefKeeper(deps: BriefDeps, everyMs = BRIEF_TICK_MS): () => void {
  let running = false;
  const beat = () => {
    if (running) return;
    running = true;
    void briefTick(deps).catch(error => deps.log(`briefs: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false; });
  };
  beat();
  const timer = setInterval(beat, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** A job whose session never got its first prompt, as the check-in reads it: its fact key, name, spawn time and the keeper's last send. */
export interface Unstarted { key: string; name: string; at: number; sentAt?: number }

/** The recorded jobs whose session still has no first prompt BRIEF_LATE_MS after their spawn. */
export async function unstartedJobs(dir: string, now: number, see: (record: BriefRecord) => Promise<BriefSeen> = seeBrief): Promise<Unstarted[]> {
  const out: Unstarted[] = [];
  for (const { record } of await readRecords(dir)) {
    if (now - record.at < BRIEF_LATE_MS) continue;
    const seen = await see(record);
    if (seen.started || seen.ended) continue;
    out.push({ key: record.kind === "child" ? record.id : `thread:${record.id}`, name: record.name, at: record.at, ...(record.sent ? { sentAt: record.sent.at } : {}) });
  }
  return out;
}

/** The facts with each job that never got its first prompt read as not started, whatever its RLM status says. */
export function withUnstarted(facts: readonly JobFact[], unstarted: readonly Unstarted[]): JobFact[] {
  if (!unstarted.length) return [...facts];
  const byKey = new Map(unstarted.map(job => [job.key, job] as const));
  return facts.map(fact => {
    const job = byKey.get(fact.key) ?? (fact.sessionId ? byKey.get(`thread:${fact.sessionId}`) : undefined);
    return job ? { ...fact, state: "unstarted", unstarted: { at: job.at, ...(job.sentAt !== undefined ? { sentAt: job.sentAt } : {}) } } : fact;
  });
}
