/**
 * The harness digest's ranking, run on a worker thread so it never holds pi-host's event loop.
 *
 * A digest loads the global and local stores (`mergedHarnessState`) and ranks every entry against the turn's words with Prime's BM25 code
 * (`vendor/prime-harness.ts`). With agent factory's 1,583 entries on 11-23 that took 134 ms to load and 675 ms to rank in a fresh process,
 * and 140 to 210 ms to rank once its caches were warm, all in one loop turn (~/work/pi-host-stalls/g-live-lines/digest-bench-1.txt).
 * A root input after any store change and each job's first request rank again, so every socket command, host request and tool call of
 * every agent waited behind it; the first root input after the 18:59 restart held the loop 1.9 s on a copy rig.
 *
 * Both callers send the job here: `deliverHarnessDigest` for a root input (`delivery`) and the `harness` section of a job's prompt
 * (`digest`). The worker runs the same functions with its own store and stem caches, so the text is the same. One worker serves the
 * process, started at the first job; if it fails, the jobs in it and later ones run on the loop as before.
 */
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { digestQueryTerms, formatDigest, mergedHarnessState, nearestLocal, nextDelivery, type DigestDelivery, type DigestFlags } from "./prime-harness.ts";

interface StoreJob {
  agentDir: string;
  /** The local store: the thread's, a conversation's or the agent's (`conversationHarnessDir`). */
  localDir?: string;
  flags: DigestFlags;
  /** The agent whose store is the local one (`formatDigest`). */
  agent?: string;
}

/** A root input's digest or update (`nextDelivery`). `recent` holds the context's message texts; only the last four count. */
export type DeliveryJob = StoreJob & { kind: "delivery"; input: string[]; recent: string[]; goal?: string; delivered: DigestDelivery[]; after: number; now: number };
/** A job prompt's `harness` section, ranked by `query`, the job's task, when there is one. */
export type DigestJob = StoreJob & { kind: "digest"; query?: string };
/** The auto-refine review's local entries: the `limit` nearest `recent`, the conversation's last message texts (`nearestLocal`). */
export type NearestJob = StoreJob & { kind: "nearest"; recent: string[]; limit: number };
type Job = DeliveryJob | DigestJob | NearestJob;

type Answer = { kind: "delivery"; delivery: DigestDelivery | undefined } | { kind: "digest"; text: string } | { kind: "nearest"; keys: string[] };
type Reply = { id: number; answer: Answer } | { id: number; error: string };

function run(job: Job): Answer {
  const state = mergedHarnessState(job.agentDir, job.localDir);
  switch (job.kind) {
    case "delivery":
      return { kind: "delivery", delivery: nextDelivery({ ...job, state, recent: job.recent.filter(Boolean).slice(-4) }) };
    case "digest":
      return { kind: "digest", text: formatDigest(state, { ...job.flags, ...(job.query ? { queryTerms: digestQueryTerms([job.query], []) } : {}) }, job.agent) };
    case "nearest":
      return { kind: "nearest", keys: nearestLocal(state, job.recent, job.limit) };
    default: {
      const _exhaustive: never = job;
      return _exhaustive;
    }
  }
}

const WORKER_MARK = "pi-host harness digest";

if (!isMainThread && workerData === WORKER_MARK && parentPort) {
  const port = parentPort;
  port.on("message", ({ id, job }: { id: number; job: Job }) => {
    let reply: Reply;
    try {
      reply = { id, answer: run(job) };
    } catch (error) {
      reply = { id, error: error instanceof Error ? error.message : String(error) };
    }
    port.postMessage(reply);
  });
}

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (answer: Answer) => void; reject: (error: Error) => void }>();

function failAll(error: Error): void {
  worker = undefined;
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

/** The worker keeps the process alive only while a job waits on it, so a test or a script ends once its digests are in. */
function settle(id: number): { resolve: (answer: Answer) => void; reject: (error: Error) => void } | undefined {
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
  fresh.on("exit", code => { if (worker === fresh) failAll(new Error(`harness digest worker exited with code ${code}`)); });
  worker = fresh;
  return fresh;
}

/** Runs a job on the worker; when the worker fails, runs it here and says so through `log`. */
async function offLoop(job: Job, log?: (line: string) => void): Promise<Answer> {
  try {
    return await new Promise<Answer>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const target = started();
      target.ref();
      target.postMessage({ id, job });
    });
  } catch (error) {
    log?.(`harness digest on its worker failed, ranking on the loop: ${error instanceof Error ? error.message : String(error)}`);
    return run(job);
  }
}

/** `nextDelivery` for a root input, ranked off the loop. */
export async function harnessDelivery(job: Omit<DeliveryJob, "kind">, log?: (line: string) => void): Promise<DigestDelivery | undefined> {
  const answer = await offLoop({ kind: "delivery", ...job }, log);
  if (answer.kind !== "delivery") throw new Error(`harness digest worker answered a delivery job with ${answer.kind}`);
  return answer.delivery;
}

/** The review's local entries (`nearestLocal`), ranked off the loop. */
export async function harnessNearest(job: Omit<NearestJob, "kind">, log?: (line: string) => void): Promise<string[]> {
  const answer = await offLoop({ kind: "nearest", ...job }, log);
  if (answer.kind !== "nearest") throw new Error(`harness digest worker answered a nearest job with ${answer.kind}`);
  return answer.keys;
}

/** The digest text of a job prompt's `harness` section, ranked off the loop. */
export async function harnessDigest(job: Omit<DigestJob, "kind">, log?: (line: string) => void): Promise<string> {
  const answer = await offLoop({ kind: "digest", ...job }, log);
  if (answer.kind !== "digest") throw new Error(`harness digest worker answered a digest job with ${answer.kind}`);
  return answer.text;
}
