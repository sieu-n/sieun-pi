/**
 * The run-start digest, read and ranked on a worker thread so it never holds the event loop of the process that hosts the session.
 *
 * At each run start the extension loads the global and local stores, fingerprints them and, when they changed since the digest in context,
 * ranks every entry against the last four user and assistant texts. In pi-host that ran in the loop turn that starts the run: for the live
 * global store (856 entries, 1.56 MB, 11-23) the store read took 22 ms, the fingerprint 23 ms and the ranking 0.7 to 1.2 s at 48 terms,
 * so every socket command and tool call of every session waited (work/pi-host-stalls/j-run-start/report.md).
 *
 * One worker serves the process, started at the first run. It keeps each store parsed until the file's inode, size or times change. When
 * the worker fails, the job and later ones run on the calling thread, as before, and stderr says so once per failure.
 */
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { buildDelta, buildDigest, buildQueryTerms, digestMessageContent, fingerprint, updateMessageContent, type DigestOptions } from "../core/digest.ts";
import { filesIdentity, mergeStates, readState, type HarnessState, type Scope } from "../core/store.ts";

export const DIGEST_TYPE = "harness_digest";

export type DigestFlags = Pick<DigestOptions, "includeIpythonExamples" | "includeShellExamples" | "includeRefineExamples">;

/** A digest or update message already in the session's context. */
export interface Delivered {
  at: number;
  text: string;
  details?: { digest?: string; stateFingerprint?: string };
}

export interface DigestMessage {
  customType: typeof DIGEST_TYPE;
  content: string;
  display: false;
  details: { digest: string; stateFingerprint: string; stacked?: true };
}

interface Stores {
  globalDir: string;
  localDir?: string;
  flags: DigestFlags;
  /** The context's user and assistant texts, then the prompt; only the last four rank (`buildQueryTerms`). */
  recent: string[];
}

/** The message route: the digest, an update, or nothing when `delivered` already has the current state. */
export type MessageJob = Stores & { kind: "message"; delivered: Delivered[] };
/** The section route: the section text when the state's fingerprint is not `known`. */
export type SectionJob = Stores & { kind: "section"; known?: string };
export type DigestJob = MessageJob | SectionJob;

export type DigestAnswer = { kind: "message"; message: DigestMessage | undefined } | { kind: "section"; fingerprint: string; text: string | undefined };

const stores = new Map<string, { identity: string; state: HarnessState }>();

function storeOf(dir: string, scope: Scope): HarnessState {
  const identity = filesIdentity([dir]);
  const key = `${scope}\0${dir}`;
  const kept = stores.get(key);
  if (kept?.identity === identity) return kept.state;
  const state = readState(dir, scope);
  stores.set(key, { identity, state });
  return state;
}

/** The answer to one job, the same text the extension built on the loop before. */
export function runDigestJob(job: DigestJob): DigestAnswer {
  const state = mergeStates(storeOf(job.globalDir, "global"), job.localDir ? storeOf(job.localDir, "local") : undefined);
  const options: DigestOptions = { ...job.flags, queryTerms: buildQueryTerms(undefined, job.recent.slice(-4)) };
  const print = fingerprint(state, job.flags);
  switch (job.kind) {
    case "section":
      return { kind: "section", fingerprint: print, text: job.known === print ? undefined : buildDigest(state, options) };
    case "message": {
      const latest = job.delivered.filter(d => d.details?.digest !== undefined).at(-1);
      if (latest?.details?.stateFingerprint === print) return { kind: "message", message: undefined };
      const digest = buildDigest(state, options);
      if (!latest) return { kind: "message", message: { customType: DIGEST_TYPE, content: digestMessageContent(digest), display: false, details: { digest, stateFingerprint: print } } };
      const delta = buildDelta(state, job.delivered.map(d => d.text), latest.at, options);
      const content = delta === undefined ? digestMessageContent(digest) : updateMessageContent(delta);
      return { kind: "message", message: { customType: DIGEST_TYPE, content, display: false, details: { digest, stateFingerprint: print, stacked: true } } };
    }
    default: {
      const _exhaustive: never = job;
      return _exhaustive;
    }
  }
}

const WORKER_MARK = "pi-harness run-start digest";
type Reply = { id: number; answer: DigestAnswer } | { id: number; error: string };

if (!isMainThread && workerData === WORKER_MARK && parentPort) {
  const port = parentPort;
  port.on("message", ({ id, job }: { id: number; job: DigestJob }) => {
    let reply: Reply;
    try {
      reply = { id, answer: runDigestJob(job) };
    } catch (error) {
      reply = { id, error: error instanceof Error ? error.message : String(error) };
    }
    port.postMessage(reply);
  });
}

type Waiter = { resolve: (answer: DigestAnswer) => void; reject: (error: Error) => void };
let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, Waiter>();

function failAll(error: Error): void {
  worker = undefined;
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

/** The worker keeps the process alive only while a job waits on it, so a test or a script ends once its digests are in. */
function settle(id: number): Waiter | undefined {
  const waiter = pending.get(id);
  pending.delete(id);
  if (!pending.size) worker?.unref();
  return waiter;
}

function started(): Worker {
  if (worker) return worker;
  const fresh = new Worker(new URL(import.meta.url), { workerData: WORKER_MARK });
  fresh.unref();
  fresh.on("message", (reply: Reply) => {
    const waiter = settle(reply.id);
    if (!waiter) return;
    if ("error" in reply) waiter.reject(new Error(reply.error));
    else waiter.resolve(reply.answer);
  });
  fresh.on("error", error => { if (worker === fresh) failAll(error); });
  fresh.on("exit", code => { if (worker === fresh) failAll(new Error(`exited with code ${code}`)); });
  worker = fresh;
  return fresh;
}

/** Runs a job on the worker; when the worker fails, runs it on this thread and says so on stderr. */
export async function digestOffLoop(job: DigestJob): Promise<DigestAnswer> {
  try {
    return await new Promise<DigestAnswer>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const target = started();
      target.ref();
      target.postMessage({ id, job });
    });
  } catch (error) {
    process.stderr.write(`pi-harness: the digest worker failed, building the digest on the loop: ${error instanceof Error ? error.message : String(error)}\n`);
    return runDigestJob(job);
  }
}
