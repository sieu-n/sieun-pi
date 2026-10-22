import { open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobFact } from "./checkin-steps.ts";
import { JOB_CLEANUP_EVERY_MS } from "./chat-checkin.ts";
import { CUT_CONFIRM_BYTES, CUT_TAIL_BYTES, tailLines } from "./cut-end.ts";
import { turnError } from "./shared/credential-wait.ts";
import type { InterruptedRun } from "./shared/interrupted.ts";

/**
 * Turns the chat service gives back itself, so the check-in reads their steps as moving: a cut step owner the resume pass continues
 * (`InterruptedRuns.resumeJobs`). On 10-15 the four frontend bro jobs cut at 16:07Z read job_ended until their continue at 16:32Z.
 */

/** The cut step owners the last resume pass found, with why each is held: `{ at, runs: [{ session, reason }] }`. */
export const RESUME_PENDING_FILE = "resume-pending.json";
/** A resume list older than two job sweeps is from a service that stopped running its pass. */
export const RESUME_PENDING_FRESH_MS = 2 * JOB_CLEANUP_EVERY_MS + 60_000;

export interface HeldTurns {
  /** Held sessions by session id, with what holds them, worded to follow "sleeps on" (`JobFact.wake`). */
  sessions: ReadonlyMap<string, string>;
}

const readJson = async (file: string): Promise<unknown> => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; } };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What the service holds now, from its data folder; a missing, broken or stale file holds nothing. */
export async function readHeldTurns(dataDir: string, now: number): Promise<HeldTurns> {
  const pendingFile = await readJson(join(dataDir, RESUME_PENDING_FILE));
  const sessions = new Map<string, string>();
  if (isRecord(pendingFile) && typeof pendingFile.at === "number" && now - pendingFile.at <= RESUME_PENDING_FRESH_MS && Array.isArray(pendingFile.runs)) {
    for (const run of pendingFile.runs) {
      if (isRecord(run) && typeof run.session === "string")
        sessions.set(run.session, `the chat service's continue after its cut turn (${typeof run.reason === "string" ? run.reason : "cut"})`);
    }
  }
  return { sessions };
}

/** The facts with each job whose session the service holds marked working, and what holds it named as its wake (`JobFact.wake`). */
export function withHeldTurns(facts: readonly JobFact[], held: ReadonlyMap<string, string>, sessionOf: (key: string) => string | undefined): JobFact[] {
  if (!held.size) return [...facts];
  return facts.map(fact => {
    if (fact.state === "working") return fact;
    const session = fact.key.startsWith("thread:") ? fact.key.slice("thread:".length) : fact.sessionId ?? sessionOf(fact.key);
    const why = session === undefined ? undefined : held.get(session);
    return why ? { ...fact, state: "working", wake: why } : fact;
  });
}

/** Rewrites RESUME_PENDING_FILE with the cut runs one resume pass found, through a temp file. */
export async function writeResumePending(dataDir: string, runs: readonly Pick<InterruptedRun, "session_id" | "reason">[], at: number): Promise<void> {
  const file = join(dataDir, RESUME_PENDING_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  const body = { at, runs: runs.flatMap(run => run.session_id ? [{ session: run.session_id, reason: run.reason }] : []) };
  await writeFile(temp, JSON.stringify(body)).then(() => rename(temp, file));
}

/**
 * The error a session's own transcript ends on: its last assistant message failed (stopReason "error") and no input, pi-pool queue place or
 * tool result came after it. Prime holds such a turn in its provider retry or with its input stopped, so a message sent to it waits unseen.
 * On 10-18 16 jobs of Crawler VP ended on "Provider rate limit exceeded ... waits for its slot at 21:49:27Z" at 19:53Z, the daemon still
 * listed them running, the check-in read "working, no activity for 58 min" and steered them, and the steers sat in their queues.
 */
export function lastTurnError(tail: string): string | undefined {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    let line: { type?: unknown; customType?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown; diagnostics?: unknown } };
    try { line = JSON.parse(lines[index]!); } catch { continue; }
    if (line.type === "custom" && line.customType === "pi-pool-queue") return undefined;
    if (line.type === "custom_message" && line.customType === "agent_message") return undefined;
    if (line.type !== "message" || !line.message) continue;
    if (line.message.role !== "assistant" || line.message.stopReason !== "error") return undefined;
    const error = turnError(line.message);
    return error?.trim() ? error : "error";
  }
  return undefined;
}

const TAIL_BYTES = 64 * 1024;
/** The one session transcript in a spawned child's folder, by its id; undefined when the folder holds none or several. */
async function soleSession(dir: string): Promise<string | undefined> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(".jsonl") && name !== "semantic-edges.jsonl");
  return files.length === 1 ? files[0]!.slice(0, -6) : undefined;
}
async function tailOf(file: string): Promise<string> {
  const size = (await stat(file).catch(() => null))?.size;
  if (!size) return "";
  const handle = await open(file, "r");
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally { await handle.close(); }
}

/**
 * Each fact of a thread or a sub-job of the chat whose transcript ends on a failed turn (`lastTurnError`) reads failed with that error,
 * whatever the daemon says: a turn in Prime's provider retry lists as running. A job-steer then restarts it (abort, the message, resume the
 * queue), as the owner's hand fix did at 20:56Z on 10-18, and a pool wait in the error keeps the check-in's own pushes off it (`poolWait`).
 * A wake or a held continue it had goes, since its stopped queue would hold that message too. A thread's transcript is
 * `<agentDir>/sessions/<id>.jsonl`, a sub-job's `<agentDir>/sessions/<session id>.jsonl` when rlm.create_session started it, or
 * `<agentDir>/session-artifacts/<chat>/sub-*\/<session id>.jsonl`, else the file the catalog lists for that session (`fileOf`). A subagent of a
 * duty job sits under that job's folder: ops guy's hyperdx error logs (01a154a4) under check-in 23:40's sub-299e90d1 waited on pi-pool slots
 * from 08:20Z to 13:15Z on 10-20, and with only the agents panel's cut line to read, the check-ins at 10:03Z and 11:23Z read it failed and p439
 * stuck, and the server restarted it into another 429.
 */
export async function withFailedTurns(facts: readonly JobFact[], agentDir: string, chat: string, sessionOf: (key: string) => string | undefined = () => undefined,
  fileOf: (session: string) => Promise<string | undefined> = async () => undefined): Promise<JobFact[]> {
  const artifacts = join(agentDir, "session-artifacts", chat);
  const subs = (await readdir(artifacts).catch(() => [] as string[])).filter(name => name.startsWith("sub-"));
  const tail = async (file: string): Promise<string> => tailOf(file).catch(() => "");
  return Promise.all(facts.map(async fact => {
    if (fact.cancelled || fact.state === "unstarted") return fact;
    let text = "";
    if (fact.key.startsWith("thread:")) text = await tail(join(agentDir, "sessions", `${fact.key.slice("thread:".length)}.jsonl`));
    else {
      // A spawned child whose row carries no session id still has its own folder, sub-<id>/, under the chat: VP of CI's sub-583d2972 and
      // metal-management's sub-1582194f were restarted at 01:05Z on 10-19 while both transcripts ended on a pool slot wait.
      const session = fact.sessionId ?? sessionOf(fact.key) ?? (fact.key.startsWith("sub-") ? await soleSession(join(artifacts, fact.key)) : undefined);
      if (!session) return fact;
      // A job started with rlm.create_session is a root under sessions/; a spawned one sits under its chat's session-artifacts.
      text = await tail(join(agentDir, "sessions", `${session}.jsonl`));
      for (const sub of subs) { if (text) break; text = await tail(join(artifacts, sub, `${session}.jsonl`)); }
      if (!text) { const file = await fileOf(session).catch(() => undefined); if (file) text = await tail(file); }
    }
    const error = lastTurnError(text);
    if (error === undefined) return fact;
    // A session the daemon still lists at work whose turn failed on a rate limit after a pi-pool slot is in Prime's provider retry, which queues
    // it in pi-pool again each try: it waits for an account. AI harness 10-21 16:13Z to 16:20Z: digest cache integration failed on a 429 three times, each followed
    // by a pi-pool-queue entry (50th, 41st, 53rd), and the check-in read it failed and p831 stalled. A place the failed turn already used is
    // not shown: at 16:2xZ wiki behind code root cause would have read "queued 22nd" from its 15:24Z entry, used by its 15:25Z turn.
    if (fact.state === "working" && POOL_WAIT.test(error) && inPoolRetry(text)) return { ...fact, retrying: true };
    const { wake: _, ...rest } = fact;
    return { ...rest, state: "failed", error };
  }));
}

/** A failed call's error that says a provider limit or pi-pool held it. */
export const POOL_WAIT = /\brate_limit_error\b|\b429\b|\brate limit\b|\bpi-pool:/i;
/**
 * Whether a session whose transcript ends on a failed turn is in Prime's provider retry with pi-pool: a pi-pool-queue entry came after its last
 * model reply that did not fail. Its newest entry came before the last failure, so that slot was used and the retry has not queued again yet;
 * a queue entry after the failure ends the failed turn (`lastTurnError`), and the pool's live reading gives that place (`withQueuePlaces`).
 */
export function inPoolRetry(tail: string): boolean {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    let line: { type?: unknown; customType?: unknown; message?: { role?: unknown; stopReason?: unknown } };
    try { line = JSON.parse(lines[index]!); } catch { continue; }
    if (line.type === "message" && line.message?.role === "assistant" && line.message.stopReason !== "error") return false;
    if (line.type === "custom" && line.customType === "pi-pool-queue") return true;
  }
  return false;
}

/** Whether a job's model turn ended after `since`, or else the pool time the error of its last failed turn names (`slotAt`) and that turn's provider. */
export type TurnSince = { ran: true; at: number } | { ran: false; error?: string; slotAt?: number; provider?: string };
// `at` is the latest turn that ended after `since`, so one read covers every fire the job took before it.

const POOL_TIME = /(?:limited until|waits for its slot at) (\d{4}-\d\d-\d\dT[\d:.]+Z)/g;

/**
 * Reads a transcript for a model turn that ended after `since`: an assistant message that did not fail. A job that pi-pool held before its
 * first call has only failed ones, such as "pi-pool: this session waits for its slot at 2026-10-19T12:38:00.000Z", and the latest pool time
 * such an error names is `slotAt`. On 10-19 job 01a15416 for metal-prod-crawler-netns-ports failed its first call that way at 12:15:17Z and
 * still had no turn at 14:46Z.
 */
export function turnSince(text: string, since: number): TurnSince {
  let error: string | undefined;
  let provider: string | undefined;
  let ran: number | undefined;
  for (const raw of text.split("\n")) {
    let line: { type?: unknown; timestamp?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown; diagnostics?: unknown; provider?: unknown } };
    try { line = JSON.parse(raw); } catch { continue; }
    if (line.type !== "message" || line.message?.role !== "assistant" || typeof line.timestamp !== "string") continue;
    const at = Date.parse(line.timestamp);
    if (!(at >= since)) continue;
    if (line.message.stopReason !== "error") { ran = at; error = undefined; continue; }
    const failed = turnError(line.message);
    error = failed?.trim() ? failed : "error";
    provider = typeof line.message.provider === "string" ? line.message.provider : undefined;
  }
  if (ran !== undefined) return { ran: true, at: ran };
  if (error === undefined) return { ran: false };
  const slots = [...error.matchAll(POOL_TIME)].map(match => Date.parse(match[1]!)).filter(Number.isFinite);
  return { ran: false, error, ...slots.length ? { slotAt: Math.max(...slots) } : {}, ...provider ? { provider } : {} };
}

/** `turnSince` over the transcript at `file`; a missing file has no turn. */
export async function readTurnSince(file: string, since: number): Promise<TurnSince> {
  return turnSince(await readFile(file, "utf8").catch(() => ""), since);
}

const QUOTA_PARK = '"customType":"provider_quota_park"';
const QUOTA_RESUME = '"customType":"provider_quota_resume"';
const POOL_PLACE = '"customType":"pi-pool-queue"';

/**
 * Whether a session's last turn ended parked with no reply: from the end of its lines, a failed assistant message, a provider quota park or
 * resume, or a pi-pool queue place comes before any assistant message that did not fail. Such a job did not end its task, whatever its reply
 * flag says, so its report is not in. mac-management 10-22 02:17Z: the service handed p24 back to the chat as "job metal agent queue reported
 * at 11:04", and that 02:04Z turn of 01a16159-1c35-76dd-abc6-77a8686fe2ff had parked on the Claude limit with no output.
 */
export function endsParked(lines: readonly string[]): boolean {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (line.includes(QUOTA_PARK) || line.includes(QUOTA_RESUME) || line.includes(POOL_PLACE)) return true;
    if (!line.includes('"role":"assistant"')) continue;
    let entry: { type?: unknown; message?: { role?: unknown; stopReason?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "message" && entry.message?.role === "assistant") return entry.message.stopReason === "error";
  }
  return false;
}

/** `endsParked` over the last CUT_TAIL_BYTES of a session file; a missing file is not parked. */
export async function readEndsParked(file: string): Promise<boolean> {
  return endsParked(await tailLines(file, CUT_TAIL_BYTES));
}

/**
 * When Prime resumes a session it parked on a provider wait, from its transcript lines: the resumeAt of the last provider_quota_park entry
 * when that is after `now` and no provider_quota_resume entry follows it (agent-session.ts `_parkForQuotaReset`, `_completeQuotaParkResume`).
 * Null when the session is not parked; undefined when the lines hold neither entry.
 */
export function quotaParkEnd(lines: readonly string[], now: number): number | null | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (line.includes(QUOTA_RESUME)) return null;
    if (!line.includes(QUOTA_PARK)) continue;
    let entry: { data?: { resumeAt?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    const at = typeof entry.data?.resumeAt === "string" ? Date.parse(entry.data.resumeAt) : NaN;
    return at > now ? at : null;
  }
  return undefined;
}

/**
 * `quotaParkEnd` of a session file, from the tails `readCut` reads (CUT_TAIL_BYTES up to CUT_CONFIRM_BYTES) until one holds a park or resume
 * entry. A parked session writes little after its park, since the chat service holds its notices (`Chats.tell`). Null when the file is gone.
 */
export async function readQuotaPark(file: string, now: number): Promise<number | null> {
  for (const bytes of [CUT_TAIL_BYTES, 1_000_000, CUT_CONFIRM_BYTES]) {
    const end = quotaParkEnd(await tailLines(file, bytes), now);
    if (end !== undefined) return end;
  }
  return null;
}
