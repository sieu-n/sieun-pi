import { ARCHIVE_RETRY_MS, ARCHIVE_TICK_MS } from "./chat-archive-queue.ts";
import { type JsonFile, snapshotJsonFile, transactJsonFile } from "./locked-json.ts";

/**
 * The archives whose scheduled-job cancel (`archive_saved_session`) the session's daemon has not confirmed yet
 * (`<data dir>/saved-archive-queue.json`). Each entry keeps the box and the path that box's daemon knows the file by, as the archive found
 * them, and when the archive began, which `ThreadHub.retryCancel` reads the session file against. An entry of the service's own archive keeps
 * that archive's operation in service-archives.json (`op`), so the retry's confirmed cancel lands its line there: Prime writes owner_archive on
 * every archive_saved_session, and before, a retry of the 10-21 11:19:39Z idle_root_end archive of 01a159e2 would have read as the owner's. The queue retries on the duty archive queue's schedule (ARCHIVE_RETRY_MS, the last wait
 * repeating) and at once on the first tick after a box that was down at the last try answers again. It never gives up: only a confirmed
 * cancel, the owner's unarchive or reopen (`supersede`), or a message the session accepted after the archive ends an entry.
 */
export interface PendingCancel {
  id: string; host: string | null; sessionPath: string; archivedAt: number;
  queuedAt: number; tries: number; nextAt: number; offline: boolean; error: string;
  /** The service archive operation (service-archives.json) this cancel belongs to; absent for the owner's archive. */
  op?: string;
}

/** One try's end: `done` drops the entry (with a log line when `note` says why it ended without a cancel); `again` keeps it. */
export type CancelTry = { outcome: "done"; note?: string } | { outcome: "again"; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseEntry(value: unknown): PendingCancel | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.sessionPath !== "string") return undefined;
  if (!(value.host === null || typeof value.host === "string")) return undefined;
  if (![value.archivedAt, value.queuedAt, value.tries, value.nextAt].every(finite)) return undefined;
  return { id: value.id, host: value.host, sessionPath: value.sessionPath, archivedAt: value.archivedAt as number, queuedAt: value.queuedAt as number,
    tries: value.tries as number, nextAt: value.nextAt as number, offline: value.offline === true, error: typeof value.error === "string" ? value.error : "",
    ...typeof value.op === "string" ? { op: value.op } : {} };
}

const waitAfter = (tries: number): number => ARCHIVE_RETRY_MS[Math.min(Math.max(tries, 1), ARCHIVE_RETRY_MS.length) - 1]!;

export class SavedArchiveQueue {
  private readonly file: JsonFile<PendingCancel[]>;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Map<string, Promise<void>>();
  private draining: Promise<void> | undefined;

  /** `attempt` runs one try of an entry still queued. `reachable` says whether a box's daemon link is up now. `tickMs` 0 starts no timer. */
  constructor(private readonly options: { path: string; attempt: (entry: PendingCancel) => Promise<CancelTry>; reachable: (host: string | null) => boolean;
    log?: (line: string) => void; now?: () => number; tickMs?: number }) {
    this.file = { path: options.path, label: "Saved archive queue", initial: () => [],
      parse: value => (Array.isArray(value) ? value : []).flatMap(entry => { const parsed = parseEntry(entry); return parsed ? [parsed] : []; }) };
    this.now = options.now ?? Date.now;
    const tickMs = options.tickMs ?? ARCHIVE_TICK_MS;
    if (tickMs > 0) {
      this.timer = setInterval(() => { void this.drain(); }, tickMs);
      this.timer.unref();
    }
  }

  pending(): Promise<PendingCancel[]> { return snapshotJsonFile(this.file); }

  async has(id: string): Promise<boolean> { return (await this.pending()).some(entry => entry.id === id); }

  /** Records a cancel the daemon did not confirm, replacing an older entry of the same session; the first retry waits ARCHIVE_RETRY_MS[0]. */
  async add(input: Pick<PendingCancel, "id" | "host" | "sessionPath" | "archivedAt" | "error" | "op">): Promise<void> {
    const now = this.now();
    const entry: PendingCancel = { ...input, queuedAt: now, tries: 1, nextAt: now + waitAfter(1), offline: !this.options.reachable(input.host) };
    await transactJsonFile(this.file, entries => {
      const index = entries.findIndex(candidate => candidate.id === input.id);
      if (index < 0) entries.push(entry); else entries[index] = entry;
    });
  }

  /** A later archive of the session went through: its older entry has nothing left to do. */
  async done(id: string): Promise<void> {
    await transactJsonFile(this.file, entries => { const index = entries.findIndex(entry => entry.id === id); if (index >= 0) entries.splice(index, 1); });
  }

  /**
   * The owner unarchived or reopened the session: its entry goes, and this waits for a try already out, so no cancel lands after the reopen's
   * own writes and create.
   */
  async supersede(id: string): Promise<void> {
    await this.done(id);
    await this.running.get(id);
  }

  /** Tries every due entry, one at a time; a second call while one runs shares it. Never rejects. */
  drain(): Promise<void> {
    return this.draining ??= this.run().catch(error => this.options.log?.(`saved archive queue: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.draining = undefined; });
  }

  private async run(): Promise<void> {
    for (const entry of await this.pending()) {
      const back = entry.offline && this.options.reachable(entry.host);
      if (entry.nextAt > this.now() && !back) continue;
      const work = this.once(entry.id);
      this.running.set(entry.id, work);
      await work.finally(() => { if (this.running.get(entry.id) === work) this.running.delete(entry.id); });
    }
  }

  /** One try of the session's entry as the file holds it when the try starts, so an entry superseded meanwhile is never tried. */
  private async once(id: string): Promise<void> {
    const entry = (await this.pending()).find(candidate => candidate.id === id);
    if (!entry) return;
    const result = await this.options.attempt(entry).catch((error: unknown): CancelTry => ({ outcome: "again", error: error instanceof Error ? error.message : String(error) }));
    const now = this.now();
    const tries = entry.tries + 1;
    await transactJsonFile(this.file, entries => {
      const index = entries.findIndex(candidate => candidate.id === id);
      if (index < 0 || entries[index]!.queuedAt !== entry.queuedAt) return;
      if (result.outcome === "done") { entries.splice(index, 1); return; }
      entries[index] = { ...entries[index]!, tries, nextAt: now + waitAfter(tries), offline: !this.options.reachable(entry.host), error: result.error.slice(0, 300) };
    });
    const name = `${id} on ${entry.host ?? "this box"}`;
    if (result.outcome === "again") this.options.log?.(`saved archive queue: cancel for ${name} try ${tries} failed, retrying later: ${result.error}`);
    else this.options.log?.(`saved archive queue: ${result.note ? `dropped the cancel for ${name}: ${result.note}` : `cancelled the scheduled jobs of ${name} on try ${tries}`}`);
  }

  close(): void { clearInterval(this.timer); }
}
