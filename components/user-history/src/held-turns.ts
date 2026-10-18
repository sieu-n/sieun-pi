import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobFact } from "./checkin-steps.ts";
import { JOB_CLEANUP_EVERY_MS } from "./chat-checkin.ts";
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
