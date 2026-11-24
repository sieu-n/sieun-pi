/**
 * A `chat.doc` read from a thread file that is not open: pi-durable's own Session over the file reads the doc, with no Harness, so no task
 * graph, prompt, kernel, index backfill or pool label comes up, and the file closes when the read ends.
 *
 * apps/chat's agent.ref check (apps/chat/server/agents.ts `verifyRefs`) reads the ref of each of about 1,800 agent threads, one every
 * 500 ms, pass after pass. Through a full open each read kept its thread open until the 10 min idle close, so on 11-23 pi-host held 1,155
 * of 2,326 thread files open 12 min after a start, and a cold open under that load held the loop up to 2 s (~/work/pi-host-stalls/f-boot/).
 *
 * The read runs on a worker thread. Each read creates the file's -wal and -shm files, truncates and grows the -shm, takes the write lock for
 * pi-durable's migration check, and on close truncates the WAL and unlinks both files. node:sqlite makes those calls on the calling thread,
 * so on the loop a file system slow to take metadata writes held every socket command: on 11-23 at 23:54Z five reads held the loop 518 to
 * 686 ms each while its thread ran on a core 8 to 19 ms. A write lock another connection holds on the file did the same, for up to the 5 s
 * busy timeout (~/work/pi-host-stalls/q-sqlite-exec/report.md). One worker serves the process, started at the first read; if it fails, the
 * reads waiting on it and later ones run on the loop as before.
 */
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ChatDoc } from "./chat-doc.ts";

export interface DocPeek {
  file: string;
  conversation: ConversationId;
  name: string;
}

type Reply = { id: number; value: JsonValue | null } | { id: number; error: string };

/** The doc's value as `harness.snapshot(ChatDoc, ...)` gives it on the open thread, or null when the conversation has no such doc. */
async function readDoc({ file, conversation, name }: DocPeek): Promise<JsonValue | null> {
  const session = createSession(await openNodeSqliteStorage(file));
  try {
    return (await session.snapshot(ChatDoc, conversation, name, BACKGROUND_CONTEXT))?.value ?? null;
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}

const WORKER_MARK = "pi-host doc peek";

if (!isMainThread && workerData === WORKER_MARK && parentPort) {
  const port = parentPort;
  port.on("message", ({ id, peek }: { id: number; peek: DocPeek }) => {
    readDoc(peek).then(
      value => port.postMessage({ id, value } satisfies Reply),
      (error: unknown) => port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies Reply),
    );
  });
}

/** The worker stopped, so the read runs on the loop. A read's own error, such as a locked or missing table, is a plain Error. */
class WorkerDown extends Error {}

type Waiter = { resolve: (value: JsonValue | null) => void; reject: (error: Error) => void };

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, Waiter>();

function failAll(error: Error): void {
  worker = undefined;
  for (const waiter of pending.values()) waiter.reject(new WorkerDown(error.message));
  pending.clear();
}

/** The worker keeps the process alive only while a read waits on it, so a test or a script ends once its reads are in. */
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
    else waiter.resolve(reply.value);
  });
  fresh.on("error", error => { if (worker === fresh) failAll(error); });
  fresh.on("exit", code => { if (worker === fresh) failAll(new Error(`doc peek worker exited with code ${code}`)); });
  worker = fresh;
  return fresh;
}

/** A closed thread's doc, read on the worker; when the worker fails, read here, which `log` says. */
export async function peekDoc(peek: DocPeek, log?: (line: string) => void): Promise<JsonValue | null> {
  try {
    return await new Promise<JsonValue | null>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const target = started();
      target.ref();
      target.postMessage({ id, peek });
    });
  } catch (error) {
    if (!(error instanceof WorkerDown)) throw error;
    log?.(`doc peek on its worker failed, reading on the loop: ${error.message}`);
    return readDoc(peek);
  }
}
