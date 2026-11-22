/**
 * The newest lean entries of the conversations whose pages were read lately, so a repeat read of a page costs one one-entry pi-host read
 * instead of the 100 to 2,100 entries a page widens over. pi-host appends entries with ids that only grow and never edits one, so the held
 * entries stay right: a read checks the newest id and fetches only the entries after the newest held.
 *
 * The tails outlive a restart: a server writes each changed tail to `dir` in the background (`save`), and the next server reads a
 * conversation's file on its first read of it. On 11-22 the chat restarted 27 to 31 times an hour during release walks, and 253 of the
 * 269 page reads that went to pi-host whole in one such hour were the first read of their conversation after a restart
 * (~/work/thread-reads/window.py).
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EntryRecord, Host } from "./host/types.ts";

export interface EntryPage {
  /** Newest first, as `Host.entries` answers a read without `after`. */
  entries: EntryRecord[];
  /** Whether the conversation has entries older than the last one in `entries`. */
  more: boolean;
}

/** Reads the conversation's lean entries before `before` (exclusive; undefined reads from the newest), newest first. */
export type ReadBefore = (before: number | undefined, limit: number) => Promise<EntryPage>;

interface Tail {
  /** Every entry of the conversation from the newest down to the oldest held, newest first. */
  entries: EntryRecord[];
  /** Whether the conversation has entries older than the oldest held. */
  more: boolean;
}

/** How many entries one read after the newest held asks for. */
const CATCH_UP = 100;
/**
 * The most entries a saved tail keeps, newest first: a newest page and its widening read about 140 to 300. On 11-22 a file of 500 live
 * entries was 0.6 to 1.3 MB and took 4 to 11 ms to write as JSON and as long to read (~/work/thread-reads/save-cost.mts).
 */
const SAVE_KEEP = 300;
/** A saved tail older than this is left unread and deleted: catching it up could cost more reads than reading the page again. */
const SAVED_FOR_MS = 10 * 60_000;
/** How long after a tail changes its file is written; a tail that changes again meanwhile is written once. */
const SAVE_EVERY_MS = 5000;

export class TailCache {
  private readonly tails = new Map<string, Tail>();
  /** The keys whose tail changed since its file was written. */
  private readonly dirty = new Set<string>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  /** When `save` last deleted the files older than SAVED_FOR_MS. */
  private swept = 0;

  /**
   * @param conversations how many conversations keep a tail; 64 held the conversation of 97% of the 37,639 GET /api/c/:id/items reads
   *   in the :5184 request logs of 2026-11-20 and 11-21, replayed as least recently read first out.
   * @param keep the most entries one tail holds, the most one newest page reads.
   */
  constructor(private readonly host: Pick<Host, "entries">, private readonly conversations: number, private readonly keep: number, private readonly dir?: string) {}

  /**
   * A reader for one conversation's page reads before `before`. A read from the newest (`before` undefined) or past the newest held first
   * checks the newest entry with a one-entry read; a read inside the held entries reads nothing; any other read goes straight to pi-host.
   */
  async reader(thread: string, conversation: number, before: number | undefined): Promise<ReadBefore> {
    const key = `${thread}:${conversation}`;
    let tail = this.tails.get(key) ?? (await this.load(key));
    if (tail) {
      this.tails.delete(key);
      this.tails.set(key, tail);
    }
    const newest = tail?.entries[0]?.id;
    if (before === undefined || (newest !== undefined && before > newest + 1)) tail = await this.sync(key, thread, conversation, tail);
    else if (newest === undefined || before < tail!.entries.at(-1)!.id) tail = undefined;
    if (!tail) return (from, limit) => this.host.entries(thread, { conversation, ...(from === undefined ? {} : { before: from }), limit, lean: true });
    const held = tail;
    return async (from, limit) => {
      const start = from === undefined ? 0 : indexBefore(held.entries, from);
      const entries = held.entries.slice(start, start + limit);
      const end = start + entries.length;
      if (entries.length === limit || end < held.entries.length || !held.more) return { entries, more: end < held.entries.length || held.more };
      const oldest = held.entries.at(-1)?.id;
      const got = await this.host.entries(thread, { conversation, ...(oldest === undefined ? {} : { before: oldest }), limit: limit - entries.length, lean: true });
      if (this.tails.get(key) === held && held.entries.length + got.entries.length <= this.keep) {
        held.entries.push(...got.entries);
        held.more = got.more;
        this.touch(key);
      }
      return { entries: [...entries, ...got.entries], more: got.more };
    };
  }

  /** The conversation's tail brought up to its newest entry, held as the key's tail. */
  private async sync(key: string, thread: string, conversation: number, tail: Tail | undefined): Promise<Tail> {
    const newest = tail?.entries[0]?.id;
    let next: Tail;
    if (newest === undefined) next = { entries: [], more: true };
    else {
      const top = (await this.host.entries(thread, { conversation, limit: 1, lean: true })).entries[0];
      if (!top) next = { entries: [], more: false };
      else if (top.id === newest) return tail!;
      else if (top.id < newest) next = { entries: [], more: true };
      else next = await this.catchUp(thread, conversation, tail!, top.id);
    }
    this.tails.delete(key);
    this.tails.set(key, next);
    if (next.entries.length) this.touch(key);
    for (const old of this.tails.keys()) {
      if (this.tails.size <= this.conversations) break;
      this.tails.delete(old);
    }
    return next;
  }

  /** Marks the key's tail for the next background write, which runs SAVE_EVERY_MS after the first mark and never on a read's path. */
  private touch(key: string): void {
    if (!this.dir || this.stopped) return;
    this.dirty.add(key);
    if (this.timer) return;
    this.timer = setTimeout(() => void this.save().catch(() => undefined), SAVE_EVERY_MS);
    this.timer.unref();
  }

  /**
   * Writes each tail that changed since its last write to `dir`, up to SAVE_KEEP entries, one file per conversation through a rename, so a
   * reader sees a file whole. A file older than SAVED_FOR_MS goes. The files are written while the server serves, so a hand-over's stop
   * writes nothing and the next server reads a conversation's file on its first read of it.
   */
  async save(): Promise<void> {
    this.timer = undefined;
    if (!this.dir) return;
    await mkdir(this.dir, { recursive: true });
    for (const key of [...this.dirty]) {
      this.dirty.delete(key);
      const tail = this.tails.get(key);
      if (!tail?.entries.length || this.stopped) continue;
      const path = join(this.dir, fileOf(key));
      await writeFile(`${path}.tmp`, JSON.stringify({ entries: tail.entries.slice(0, SAVE_KEEP), more: tail.more || tail.entries.length > SAVE_KEEP } satisfies Tail));
      await rename(`${path}.tmp`, path);
    }
    const now = Date.now();
    if (now - this.swept < SAVED_FOR_MS) return;
    this.swept = now;
    for (const name of await readdir(this.dir)) {
      const path = join(this.dir, name);
      const info = await stat(path).catch(() => undefined);
      if (info && now - info.mtimeMs > SAVED_FOR_MS) await rm(path, { force: true });
    }
  }

  /** Ends the background writes, so a stopped server never writes over a newer server's files. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The tail a server saved for `key` within SAVED_FOR_MS, which a read catches up from its newest entry. */
  private async load(key: string): Promise<Tail | undefined> {
    if (!this.dir) return undefined;
    const path = join(this.dir, fileOf(key));
    const info = await stat(path).catch(() => undefined);
    if (!info || Date.now() - info.mtimeMs > SAVED_FOR_MS) return undefined;
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (this.tails.has(key) || !text) return this.tails.get(key);
    const tail = JSON.parse(text) as Tail;
    if (!Array.isArray(tail.entries) || !tail.entries.length) return undefined;
    this.tails.set(key, tail);
    for (const old of this.tails.keys()) {
      if (this.tails.size <= this.conversations) break;
      this.tails.delete(old);
    }
    return tail;
  }

  /** `tail` with the entries after its newest up to `top`, or an empty tail when they would pass `keep`. */
  private async catchUp(thread: string, conversation: number, tail: Tail, top: number): Promise<Tail> {
    const added: EntryRecord[] = [];
    let cursor = tail.entries[0]!.id;
    while (cursor < top) {
      const got = await this.host.entries(thread, { conversation, after: cursor, limit: CATCH_UP, lean: true });
      added.push(...got.entries);
      if (added.length > this.keep) return { entries: [], more: true };
      if (!got.more || !got.entries.length) break;
      cursor = got.entries.at(-1)!.id;
    }
    const entries = [...added.reverse(), ...tail.entries];
    return entries.length > this.keep ? { entries: entries.slice(0, this.keep), more: true } : { entries, more: tail.more };
  }
}

/** A saved tail's file name: the key with its colon spelled out, as a file name allows. */
const fileOf = (key: string): string => `${encodeURIComponent(key)}.json`;
/** The index of the first entry with an id below `before` in `entries`, newest first; `entries.length` when none is. */
function indexBefore(entries: readonly EntryRecord[], before: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (entries[mid]!.id < before) high = mid;
    else low = mid + 1;
  }
  return low;
}
