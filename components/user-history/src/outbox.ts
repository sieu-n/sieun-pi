import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ChatImage } from "./chat-images.ts";
import type { OutboxAccepted, OutboxEntry } from "./shared/outbox.ts";
import type { SendMode } from "./shared/types.ts";

/*
 * The owner's sends wait on disk here until the daemon takes them. 10-18 08:16Z his send bounced with 'Timed out after 30000ms waiting for
 * the Prime Agent daemon response to "attach"' because the chat's worker had hung on a 38 to 40 GB heap since 07:49Z; the supervisor reset it
 * at 08:16:19Z "without replaying uncertain operations". So the POST answers once the send is on disk, and a loop per thread delivers in
 * order and retries every failure but a final one, for as long as the worker takes. A send that may have reached the daemon is looked for
 * (in the session file, then the worker's queue) before it goes again, so it lands once.
 */

/** One send as it is kept on disk: the page's entry, plus what the daemon needs and when a send of it began. */
export interface Stored extends OutboxEntry {
  images: ChatImage[];
  mode: SendMode;
  fingerprint: string;
  /** Set before each daemon request that may land: a failure after it is looked for before the next try. */
  sentAt?: number;
  /** When it was delivered or failed; such entries stay to answer a resend of their id and go after `keepMs`. */
  doneAt?: number;
  /** Agent messages only: the tree root to start when the daemon knows no such target (src/agent-outbox.ts). */
  root?: string;
  /** Agent messages only: what the sender meant it as, set when it is queued (`AgentKind`); absent reads as "message". */
  kind?: AgentKind;
  /** Wakes only: when the session set the wake (`Wake.since`), so a wake an archived chat set after its archive still goes. */
  setAt?: number;
  /**
   * Agent messages only: the queued messages that go in this entry's send, its own first, oldest first; `text` is their rendering
   * (src/agent-outbox.ts `bundleText`). Each keeps what its own entry held, so a resubmit of any of them finds this entry.
   */
  bundle?: Bundled[];
}

/** One message inside a bundled agent message, as its own entry held it. */
export interface Bundled { id: string; at: number; kind: AgentKind; fingerprint: string; text: string; setAt?: number }

/** What a delivery writes on its entry together with `sentAt`, before the request that may land. */
export type Sending = Partial<Pick<Stored, "text" | "kind" | "bundle">>;

/**
 * Why the service sends an agent message: "wake" for a board.wake of a time or a CI run, "retry" for a resend of a send that was already tried
 * (a spawn brief resent), and "message" for anything an agent or the owner says (a report, an instruction, a relay, an alert).
 */
export type AgentKind = "wake" | "retry" | "message";

/** What a caller hands the outbox. */
export type OutboxSubmit = Pick<Stored, "id" | "threadId" | "text" | "images" | "mode" | "fingerprint"> & { root?: string; kind?: AgentKind; setAt?: number };

/** Where a send that may have gone is. "unknown": the daemon did not answer, so it is looked for again later and not sent. */
export type Copy = "landed" | "queued" | "absent" | "unknown";

/** A delivery's answer that the entry need not go: the proof, kept on the entry as its note. */
export interface Obsolete { obsolete: string }

export interface OutboxDeps {
  dir: string;
  /**
   * One delivery. Awaits `sending()` right before the daemon request that may land, passing any change to the entry, which is written with
   * `sentAt` in one write. Throws on failure; answers `Obsolete` when it sent nothing on proof.
   */
  deliver(entry: Stored, sending: (change?: Sending) => Promise<void>): Promise<void | Obsolete>;
  /** Where a send that began at `since` is. */
  copy(entry: Stored, since: number): Promise<Copy>;
  /** Plain words when the error is final and the entry fails, null when it is tried again. */
  final(error: unknown): string | null;
  /** Whether a send that failed this way may still have reached the daemon, so it is looked for before a resend; absent means always. */
  uncertain?: (error: unknown) => boolean;
  /** Whether a failure is a wait the deps already logged, so each try of it writes no line; absent means none is. */
  quiet?: (error: unknown) => boolean;
  /** Whether the entry's target cannot be reached now, such as a session on a box that is offline: it waits, with no try and no line. */
  held?: (entry: Stored) => Promise<boolean>;
  /** The thread's queued, sending and failed entries changed; `left` is the one that was just delivered. */
  changed(threadId: string, outbox: OutboxEntry[], left?: OutboxEntry): void;
  log(line: string): void;
  /** How a line names the thread: its short id, and for an agent message to another box's session the box (`01a11d25 on mac`). */
  where?: (threadId: string) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  keepMs?: number;
}

export class OutboxConflict extends Error {}
/** A delivery that reached `sending()` after the outbox closed; it stays queued for the next start. */
class Closed extends Error {}

const KEEP_MS = 7 * 24 * 60 * 60_000;
/** The longest wait between two tries of one entry. */
export const MAX_BACKOFF_MS = 30_000;
const backoff = (attempt: number) => Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt, 5));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function publicEntry(entry: Stored): OutboxEntry {
  const { images: _images, mode: _mode, fingerprint: _fingerprint, sentAt: _sentAt, doneAt: _doneAt, bundle: _bundle, ...shown } = entry;
  return shown;
}

export class Outbox {
  private readonly entries = new Map<string, Stored>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly lanes = new Map<string, Promise<void>>();
  /** Lanes whose delivery passed `sending()`: a request that may land is out, and a draining close waits for its answer. */
  private readonly out = new Set<string>();
  private readonly ready: Promise<void>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timers = new Set<() => void>();
  private last = 0;
  private temp = 0;
  private closed = false;

  constructor(private readonly deps: OutboxDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => {
      const timer = setTimeout(() => { this.timers.delete(stop); resolve(); }, ms);
      const stop = () => { clearTimeout(timer); resolve(); };
      this.timers.add(stop);
    }));
    this.ready = this.load();
    this.ready.catch(error => deps.log(`outbox: load: ${message(error)}`));
  }

  /**
   * Keeps the send on disk and starts its delivery. A resend of an id answers its entry as it is now and sends nothing; the same id with other
   * content throws OutboxConflict.
   */
  async submit(input: OutboxSubmit): Promise<OutboxAccepted> {
    await this.ready;
    const held = this.entries.get(input.id);
    if (held) {
      if (held.fingerprint !== input.fingerprint) throw new OutboxConflict("This request ID belongs to a different message.");
      await this.writes.get(input.id);
      return { accepted: true, outbox: publicEntry(held) };
    }
    this.last = Math.max(this.now(), this.last + 1);
    const entry: Stored = { ...input, imageCount: input.images.length, state: "queued", at: this.last, attempts: 0 };
    this.entries.set(entry.id, entry);
    try { await this.save(entry); } catch (error) { this.entries.delete(entry.id); throw error; }
    this.publish(entry.threadId);
    this.kick(entry.threadId);
    return { accepted: true, outbox: publicEntry(entry) };
  }

  /** An entry not delivered or failed yet that `match` accepts. */
  async pending(match: (entry: Stored) => boolean): Promise<Stored | undefined> {
    await this.ready;
    return [...this.entries.values()].find(entry => entry.doneAt === undefined && match(entry));
  }

  /** The thread's entries not delivered or failed yet, oldest first. */
  async waiting(threadId: string): Promise<Stored[]> {
    await this.ready;
    return this.lane(threadId).filter(entry => entry.doneAt === undefined);
  }

  /** The thread's entries the page shows: queued, sending and failed, oldest first. */
  view(threadId: string): OutboxEntry[] {
    return this.lane(threadId).filter(entry => entry.state !== "delivered" && entry.state !== "obsolete").map(publicEntry);
  }

  /** Resolves when every lane has nothing left to try now; tests use it. */
  async idle(): Promise<void> {
    await this.ready;
    while (this.lanes.size) await Promise.all([...this.lanes.values()]);
  }

  /**
   * Stops the loops and waits for the writes out now; the rest goes on at the next start. `drain` also waits for the deliveries out now, so a
   * refusal that comes during a service stop is recorded as one: 10-18 06:33Z a release closed the daemon link under a wake's relay, the daemon
   * refused it, and a record that read it as maybe held kept the wake behind "the target is busy" until 06:43Z. A lane still before its send
   * (its room, obsolete and tree checks are daemon reads) is not waited for: its `sending()` refuses, so nothing goes out, and the entry waits
   * on disk for the next start. On 10-18 a stop at 21:42:19Z waited 49 s and one at 21:51:01Z 22 s, while the daemon took 30 s per read.
   */
  async close(drain = false): Promise<void> {
    this.closed = true;
    for (const stop of [...this.timers]) stop();
    if (drain) await Promise.allSettled([...this.lanes].filter(([threadId]) => this.out.has(threadId)).map(([, lane]) => lane));
    await Promise.allSettled([...this.writes.values()]);
  }

  private where(threadId: string): string { return this.deps.where?.(threadId) ?? threadId.slice(0, 8); }

  private lane(threadId: string): Stored[] {
    return [...this.entries.values()].filter(entry => entry.threadId === threadId).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }

  private kick(threadId: string): void {
    if (this.closed || this.lanes.has(threadId)) return;
    const run = this.drain(threadId).catch(error => this.deps.log(`outbox ${this.where(threadId)}: ${message(error)}`))
      .finally(() => { this.lanes.delete(threadId); if (this.lane(threadId).some(entry => entry.state === "queued" || entry.state === "sending")) this.kick(threadId); });
    this.lanes.set(threadId, run);
  }

  /** Delivers the thread's entries one at a time, in the order they came; an entry that is not done holds the ones after it. */
  private async drain(threadId: string): Promise<void> {
    let entry: Stored | undefined;
    while (!this.closed && (entry = this.lane(threadId).find(item => item.state === "queued" || item.state === "sending"))) await this.attempt(entry);
  }

  private async attempt(entry: Stored): Promise<void> {
    if (await this.deps.held?.(entry).catch(() => false)) {
      if (!this.closed) await this.sleep(MAX_BACKOFF_MS);
      return;
    }
    if (entry.sentAt !== undefined) {
      const copy = await this.deps.copy(entry, entry.sentAt).catch(() => "unknown" as const);
      if (copy === "landed" || copy === "queued") {
        this.deps.log(`outbox ${this.where(entry.threadId)}: ${entry.id} is ${copy} from the send at ${new Date(entry.sentAt).toISOString()}; not sent again`);
        return this.finish(entry, "delivered");
      }
      if (copy === "unknown") { await this.sleep(backoff(entry.attempts)); return; }
    }
    const { sentAt: _sentAt, ...unsent } = entry;
    let current = this.update(unsent, { state: "sending", attempts: entry.attempts + 1 });
    const sending = async (change?: Sending) => {
      if (this.closed) throw new Closed();
      this.out.add(current.threadId);
      current = this.update(current, { ...change, sentAt: this.now() });
      await this.writes.get(current.id);
    };
    try {
      const result = await this.deps.deliver(current, sending);
      if (result) {
        this.deps.log(`outbox ${this.where(current.threadId)}: ${current.id} obsolete, not sent: ${result.obsolete}`);
        return this.finish(current, "obsolete", result.obsolete);
      }
      return this.finish(current, "delivered");
    } catch (error) {
      if (error instanceof Closed) { current = this.update(current, { state: "queued" }); return; }
      const final = this.deps.final(error);
      if (final !== null) return this.finish(current, "failed", final);
      if (current.sentAt !== undefined && this.deps.uncertain && !this.deps.uncertain(error)) { const { sentAt: _at, ...refused } = current; current = refused; }
      if (!this.deps.quiet?.(error)) this.deps.log(`outbox ${this.where(current.threadId)}: ${current.id} try ${current.attempts}${current.sentAt === undefined ? "" : " (may have gone)"}: ${message(error)}`);
      current = this.update(current, { state: "queued" });
      if (!this.closed) await this.sleep(backoff(current.attempts));
    } finally { this.out.delete(current.threadId); }
  }

  /**
   * Ends a queued entry as obsolete with `note`, for a delivery of the same thread that took it into its own send or proved it needless; an
   * entry that is gone, done or under way is left as it is.
   */
  async settle(id: string, note: string): Promise<void> {
    await this.ready;
    const entry = this.entries.get(id);
    if (entry && entry.doneAt === undefined && entry.state === "queued") await this.finish(entry, "obsolete", note);
  }

  private finish(entry: Stored, state: "delivered" | "failed" | "obsolete", error?: string): Promise<void> {
    const { images: _images, sentAt: _sentAt, ...rest } = entry;
    const done: Stored = { ...rest, images: [], state, doneAt: this.now(), ...(error ? { error } : {}) };
    this.entries.set(done.id, done);
    void this.save(done).catch(failure => this.deps.log(`outbox: write ${done.id}: ${message(failure)}`));
    this.publish(done.threadId, state === "delivered" ? publicEntry(done) : undefined);
    this.prune();
    return this.writes.get(done.id) ?? Promise.resolve();
  }

  /** Changes the entry in memory, writes it, and tells the page; the write's promise is in `writes`. */
  private update(entry: Stored, change: Partial<Stored>): Stored {
    const next = { ...entry, ...change };
    this.entries.set(next.id, next);
    void this.save(next).catch(error => this.deps.log(`outbox: write ${next.id}: ${message(error)}`));
    this.publish(next.threadId);
    return next;
  }

  private publish(threadId: string, left?: OutboxEntry): void {
    try { this.deps.changed(threadId, this.view(threadId), left); } catch (error) { this.deps.log(`outbox ${threadId.slice(0, 8)}: push: ${message(error)}`); }
  }

  /** One write per entry at a time, each a fsynced temp file renamed over `<id>.json`, so a crash leaves the old or the new entry whole. */
  private save(entry: Stored): Promise<void> {
    const write = (this.writes.get(entry.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const file = join(this.deps.dir, `${entry.id}.json`);
      const tmp = `${file}.${process.pid}.${++this.temp}.tmp`;
      const handle = await open(tmp, "w", 0o600);
      try { await handle.writeFile(JSON.stringify(entry)); await handle.sync(); } finally { await handle.close(); }
      await rename(tmp, file);
      const dir = await open(this.deps.dir, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    });
    this.writes.set(entry.id, write);
    return write;
  }

  private prune(): void {
    const before = this.now() - (this.deps.keepMs ?? KEEP_MS);
    for (const entry of [...this.entries.values()]) {
      if (entry.doneAt === undefined || entry.doneAt >= before) continue;
      this.entries.delete(entry.id);
      const write = this.writes.get(entry.id) ?? Promise.resolve();
      this.writes.delete(entry.id);
      void write.catch(() => {}).then(() => unlink(join(this.deps.dir, `${entry.id}.json`))).catch(() => {});
    }
  }

  /** Reads every entry back after a service start and resumes the threads with sends left; a send that was in flight is looked for first. */
  private async load(): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.deps.dir)) {
      const file = join(this.deps.dir, name);
      if (name.endsWith(".tmp")) { await unlink(file).catch(() => {}); continue; }
      if (!name.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(await readFile(file, "utf8")) as Stored;
        if (typeof entry.id !== "string" || typeof entry.threadId !== "string" || typeof entry.at !== "number") continue;
        this.entries.set(entry.id, entry.state === "sending" ? { ...entry, state: "queued" } : entry);
        this.last = Math.max(this.last, entry.at);
      } catch (error) { this.deps.log(`outbox: skip ${name}: ${message(error)}`); }
    }
    this.prune();
    for (const threadId of new Set([...this.entries.values()].filter(entry => entry.doneAt === undefined).map(entry => entry.threadId))) {
      this.publish(threadId);
      this.kick(threadId);
    }
  }
}
