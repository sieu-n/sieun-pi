/**
 * The chat server's hot file writes, made in one queue off the event loop: the post logs, state.json, rooms.json, agents.json, the
 * relay cursors and the caches. Each sync write took an ext4 journal handle on the main thread, and a handle waits while the journal
 * commits: on 11-04 at a box load of 300 the main thread sat in `wait_transaction_locked` for about 60 of a 70 ms send and 100 of a 123 ms send, and at
 * load 400 a send took 2,564 ms and a /read 1,880 ms with no other request ending inside them. Queued here, a write waits in the thread pool
 * and the event loop serves every other request meanwhile.
 *
 * Writes land in the order they were queued, across files, so a feed cursor in rooms.json never lands before the posts it read. A file
 * replaced again before its write started is written once, in the later place, and appends to the file at the tail of the queue go as one
 * write. `written(path)` settles once everything queued for that file so far is on disk, which a send awaits before it answers.
 * `flushSync()` writes what has not started yet when the process exits; a write already running ends on its own.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type Op = { kind: "replace" | "append"; path: string; text: string; done: Promise<void>; settle: () => void };

const queue: Op[] = [];
const lastFor = new Map<string, Op>();
let current: Op | null = null;
let log: (line: string) => void = () => {};

/** Where a failed write is reported; the server's log once the app starts. */
export function onWriteError(write: (line: string) => void): void {
  log = write;
}

function op(kind: Op["kind"], path: string, text: string): Op {
  let settle!: () => void;
  const done = new Promise<void>(resolve => (settle = resolve));
  return { kind, path, text, done, settle };
}

/** Queues `text` as the whole new content of `path`, written to a temp file and renamed over it. */
export function replaceLater(path: string, text: string): void {
  const at = queue.findIndex(o => o.kind === "replace" && o.path === path);
  const next = op("replace", path, text);
  if (at >= 0) {
    const [old] = queue.splice(at, 1);
    void next.done.then(old!.settle);
  }
  queue.push(next);
  lastFor.set(path, next);
  kick();
}

/** Queues `value` as JSON in the same shape as store.ts `writeJson`. */
export function writeJsonLater(path: string, value: unknown): void {
  replaceLater(path, `${JSON.stringify(value, null, 1)}\n`);
}

/** Queues `text` at the end of `path`. */
export function appendLater(path: string, text: string): void {
  const tail = queue.at(-1);
  if (tail?.kind === "append" && tail.path === path) {
    tail.text += text;
    return;
  }
  const next = op("append", path, text);
  queue.push(next);
  lastFor.set(path, next);
  kick();
}

/**
 * `path` as the queue will leave it: the file, then each write for it still queued or running, in order; undefined when neither exists. A
 * running append may be on disk in part, so its lines can read twice, and the post log and the outbox both read a repeated line as a no-op.
 */
export function readLatest(path: string): string | undefined {
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = undefined;
  }
  for (const next of [...(current ? [current] : []), ...queue]) {
    if (next.path !== path) continue;
    text = next.kind === "replace" ? next.text : (text ?? "") + next.text;
  }
  return text;
}

/** Settles once every write queued for `path` so far is on disk, or failed and was logged. */
export function written(path: string): Promise<void> {
  return lastFor.get(path)?.done ?? Promise.resolve();
}

/** Starts the queue after the current task, so a sync run of writes queues whole and `flushSync()` in that task gets all of it. */
function kick(): void {
  queueMicrotask(() => void run());
}

async function run(): Promise<void> {
  if (current) return;
  while (queue.length) {
    const next = (current = queue.shift()!);
    try {
      await mkdir(dirname(next.path), { recursive: true });
      if (next.kind === "append") await appendFile(next.path, next.text);
      else {
        const tmp = `${next.path}.${process.pid}.tmp`;
        await writeFile(tmp, next.text);
        await rename(tmp, next.path);
      }
    } catch (error) {
      log(`disk: could not write ${next.path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (lastFor.get(next.path) === next) lastFor.delete(next.path);
      current = null;
      next.settle();
    }
  }
}

/** Writes every queued write that has not started, with sync calls, for a process that is exiting. */
export function flushSync(): void {
  for (const next of queue.splice(0)) {
    try {
      mkdirSync(dirname(next.path), { recursive: true });
      if (next.kind === "append") appendFileSync(next.path, next.text);
      else {
        const tmp = `${next.path}.${process.pid}.tmp`;
        writeFileSync(tmp, next.text);
        renameSync(tmp, next.path);
      }
    } catch (error) {
      log(`disk: could not write ${next.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    next.settle();
  }
}

/** Settles once the queue is empty. */
export async function drained(): Promise<void> {
  for (let next = current ?? queue[0]; next; next = current ?? queue[0]) await next.done;
}
