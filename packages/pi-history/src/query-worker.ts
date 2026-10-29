/**
 * Runs searches off the server's event loop. A cold search over the live index took 2 to 6 s in the docs join on 10-28, and while it ran
 * the server's thread read no peer's answer, so the Mac's reply sat unread until its timeout fired and the box showed as down. A page of
 * hits and its exact count are two jobs, so two workers run them side by side.
 */
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { Query } from "./core/query.ts";
import { countPrime, type Page, type PageAsk, primeHits, type Ranked, searchDurable, type TestSend } from "./core/search.ts";
import { type ReadAnswer, ReadError, readDurable, readPrime, type Ref } from "./core/read.ts";

interface JobBase { dbPath: string; box: string; durableIndexes: string[]; query: Query; ask: PageAsk; roots: string[] | null; testSends?: TestSend[] }
interface ReadJob { op: "read"; dbPath: string; box: string; durableIndexes: string[]; ref: Ref; before: number; after: number; roots: string[] | null }
export type SearchJob = (JobBase & { op: "hits" }) | (JobBase & { op: "count" }) | ReadJob | { op: "open"; dbPath: string };
export type SearchAnswer = { op: "hits"; prime: Ranked[]; durable: Page[] } | { op: "count"; total: number } | { op: "read"; read: ReadAnswer } | { op: "open" };
export type SearchReply = { answer: SearchAnswer } | { error: string; status?: number };

const open = new Map<string, DatabaseSync | null>();
function handle(path: string): DatabaseSync | null {
  let db = open.get(path) ?? null;
  if (!db && existsSync(path)) {
    try { db = new DatabaseSync(path, { readOnly: true }); } catch { db = null; }
    open.set(path, db);
  }
  return db;
}

export function runJob(job: SearchJob): SearchAnswer {
  const prime = handle(job.dbPath);
  if (!prime) throw new Error(`No index at ${job.dbPath} yet.`);
  if (job.op === "open") {
    // Reads the schema and the fts structure record now, which a fresh connection's first search paid for (about 150 ms on 10-28).
    prime.prepare("SELECT count(*) FROM fts WHERE fts MATCH ?").get('"pi"');
    return { op: "open" };
  }
  if (job.op === "count") return { op: "count", total: countPrime(prime, job.query, job.roots) };
  if (job.op === "read") {
    const { ref } = job;
    if (ref.source === "prime") return { op: "read", read: readPrime(prime, job.box, ref, job.before, job.after, job.roots) };
    const durable = job.durableIndexes[ref.index] ? handle(job.durableIndexes[ref.index]!) : null;
    if (!durable) throw new ReadError(404, `No durable index ${ref.index} on ${job.box}.`);
    return { op: "read", read: readDurable(durable, job.box, ref, job.before, job.after, job.roots) };
  }
  return {
    op: "hits", prime: primeHits(prime, job.box, job.query, job.ask, job.roots),
    durable: job.durableIndexes.flatMap((path, at) => {
      const db = handle(path);
      return db ? [searchDurable(db, at, job.box, job.query, job.ask, job.roots, job.testSends)] : [];
    }),
  };
}

parentPort?.on("message", (job: SearchJob) => {
  let reply: SearchReply;
  try { reply = { answer: runJob(job) }; } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error), ...error instanceof ReadError ? { status: error.status } : {} };
  }
  parentPort!.postMessage(reply);
});
