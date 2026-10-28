/**
 * Runs searches off the server's event loop. A cold search over the live index took 2 to 6 s in the docs join on 10-28, and while it ran
 * the server's thread read no peer's answer, so the Mac's reply sat unread until its timeout fired and the box showed as down. A page of
 * hits and its exact count are two jobs, so two workers run them side by side.
 */
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { Query } from "./core/query.ts";
import { countPrime, type Page, type PageAsk, primeHits, type Ranked, searchDurable } from "./core/search.ts";

interface JobBase { dbPath: string; box: string; durableIndexes: string[]; query: Query; ask: PageAsk; roots: string[] | null }
export type SearchJob = (JobBase & { op: "hits" }) | (JobBase & { op: "count" }) | { op: "open"; dbPath: string };
export type SearchAnswer = { op: "hits"; prime: Ranked[]; durable: Page[] } | { op: "count"; total: number } | { op: "open" };
export type SearchReply = { answer: SearchAnswer } | { error: string };

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
  if (job.op === "open") return { op: "open" };
  if (job.op === "count") return { op: "count", total: countPrime(prime, job.query, job.roots) };
  return {
    op: "hits", prime: primeHits(prime, job.box, job.query, job.ask, job.roots),
    durable: job.durableIndexes.flatMap((path, at) => {
      const db = handle(path);
      return db ? [searchDurable(db, at, job.box, job.query, job.ask, job.roots)] : [];
    }),
  };
}

parentPort?.on("message", (job: SearchJob) => {
  let reply: SearchReply;
  try { reply = { answer: runJob(job) }; } catch (error) { reply = { error: error instanceof Error ? error.message : String(error) }; }
  parentPort!.postMessage(reply);
});
