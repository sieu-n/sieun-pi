import { type JsonFile, snapshotJsonFile, transactJsonFile } from "./locked-json.ts";
import type { DutyJobRef } from "./shared/chat-duties.ts";

/**
 * The duty job archives waiting to run (`<data dir>/duty-archive-queue.json`). Archiving a finished duty job kills its session through the
 * daemon; at a load of 293 (10-09) each `kill` and `list` timed out at 30 s and held up the next job's start 7 times. The duty runner now only
 * queues the archive: the queue tries it in the background at once, then after each wait in ARCHIVE_RETRY_MS (the last one repeats), and gives
 * up with a log line once an entry is ARCHIVE_GIVE_UP_MS old. The file keeps the entries across a restart.
 */
export interface ArchiveEntry { id: string; name: string; queuedAt: number; tries: number; nextAt: number; error?: string }

export const ARCHIVE_RETRY_MS: readonly number[] = [60_000, 120_000, 300_000, 900_000, 1_800_000];
export const ARCHIVE_GIVE_UP_MS = 24 * 60 * 60_000;
/** One archive try that has not ended after this counts as failed; the next try finds the session archived if the first one finished later. */
export const ARCHIVE_TRY_TIMEOUT_MS = 120_000;
export const ARCHIVE_TICK_MS = 30_000;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseEntry(value: unknown): ArchiveEntry | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  const numbers = [value.queuedAt, value.tries, value.nextAt];
  if (!numbers.every(entry => typeof entry === "number" && Number.isFinite(entry))) return undefined;
  return { id: value.id, name: value.name, queuedAt: value.queuedAt as number, tries: value.tries as number, nextAt: value.nextAt as number,
    ...(typeof value.error === "string" ? { error: value.error } : {}) };
}

export class ArchiveQueue {
  private readonly file: JsonFile<ArchiveEntry[]>;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private draining: Promise<void> | undefined;

  /**
   * `archive` ends the session (it resolves when the session is archived or gone). `tickMs` 0 starts no timer (tests call `drain`).
   */
  constructor(private readonly options: { path: string; archive: (id: string) => Promise<void>; log?: (line: string) => void;
    now?: () => number; tickMs?: number; tryTimeoutMs?: number }) {
    this.file = { path: options.path, label: "Duty archive queue", initial: () => [],
      parse: value => (Array.isArray(value) ? value : []).flatMap(entry => { const parsed = parseEntry(entry); return parsed ? [parsed] : []; }) };
    this.now = options.now ?? Date.now;
    const tickMs = options.tickMs ?? ARCHIVE_TICK_MS;
    if (tickMs > 0) {
      this.timer = setInterval(() => { void this.drain(); }, tickMs);
      this.timer.unref();
    }
  }

  /** Queues a job's archive and starts a drain in the background; it never waits for the archive. A job already queued stays queued once. */
  async add(job: DutyJobRef): Promise<void> {
    const now = this.now();
    await transactJsonFile(this.file, entries => {
      if (!entries.some(entry => entry.id === job.id)) entries.push({ id: job.id, name: job.name, queuedAt: now, tries: 0, nextAt: now });
    });
    void this.drain();
  }

  pending(): Promise<ArchiveEntry[]> { return snapshotJsonFile(this.file); }

  /** Tries every due entry, one at a time; a second call while one runs shares it. Never rejects. */
  drain(): Promise<void> {
    return this.draining ??= this.run().catch(error => this.options.log?.(`duty archive queue: ${message(error)}`)).finally(() => { this.draining = undefined; });
  }

  private async run(): Promise<void> {
    for (const entry of await this.pending()) {
      if (entry.nextAt > this.now()) continue;
      let error: string | undefined;
      try { await this.attempt(entry.id); }
      catch (failure) { error = message(failure).slice(0, 300); }
      await this.settle(entry, error);
    }
  }

  private attempt(id: string): Promise<void> {
    const limit = this.options.tryTimeoutMs ?? ARCHIVE_TRY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer after ${Math.round(limit / 1000)} s`)), limit);
      timer.unref();
    });
    return Promise.race([this.options.archive(id), timeout]).finally(() => clearTimeout(timer));
  }

  private async settle(entry: ArchiveEntry, error: string | undefined): Promise<void> {
    const now = this.now();
    const tries = entry.tries + 1;
    const giveUp = error !== undefined && now - entry.queuedAt >= ARCHIVE_GIVE_UP_MS;
    await transactJsonFile(this.file, entries => {
      const index = entries.findIndex(candidate => candidate.id === entry.id);
      if (index < 0) return;
      if (error === undefined || giveUp) { entries.splice(index, 1); return; }
      entries[index] = { ...entries[index]!, tries, error, nextAt: now + ARCHIVE_RETRY_MS[Math.min(tries, ARCHIVE_RETRY_MS.length) - 1]! };
    });
    if (giveUp) this.options.log?.(`duty archive queue: gave up on ${entry.name} (${entry.id}) after ${tries} tries in a day: ${error}`);
    else if (error !== undefined) this.options.log?.(`duty archive queue: archive ${entry.name} (${entry.id}) try ${tries} failed, retrying later: ${error}`);
    else if (tries > 1) this.options.log?.(`duty archive queue: archived ${entry.name} (${entry.id}) on try ${tries}`);
  }

  close(): void { clearInterval(this.timer); }
}
