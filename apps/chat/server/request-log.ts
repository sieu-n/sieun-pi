/**
 * How long each /api request took, one JSON line per request in `<data dir>/requests/<UTC day>.jsonl`, for the daily speed duty
 * (scripts/duties/api-speed.ts). The server writes its own handler time (`src: "server"`), and the web client posts the time it waited for
 * each call (`src: "client"`, POST /api/timings), which also holds the wait while another request blocks the server's one event loop. On 11-03
 * a 3.9 s search made a concurrent replies call take 2.17 s where the handler took 0.01 s, so only the client line shows what the owner feels.
 * A day file older than the duty's 24 h window can hold is deleted when the day changes.
 */
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export type TimingSource = "server" | "client";

/** One request: when it ended, who measured it, its method, route pattern (`/api/c/:id/items`), path, status and duration. */
export interface RequestTiming { at: number; src: TimingSource; m: string; r: string; p: string; s: number; ms: number }

/** A client sample as POST /api/timings takes it; the server names its route. */
export interface ClientTiming { m: string; p: string; s: number; ms: number }

/** A 24 h window spans at most two UTC days, so a file older than yesterday holds no line the duty reads. */
const KEEP_DAYS = 2;

export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

export class RequestLog {
  private day = "";
  private pending = Promise.resolve();

  constructor(readonly dir: string, private readonly log: (line: string) => void = () => {}) {}

  write(timing: RequestTiming): void {
    const day = dayOf(timing.at);
    const line = `${JSON.stringify({ ...timing, ms: Math.round(timing.ms * 10) / 10 })}\n`;
    this.pending = this.pending.then(async () => {
      if (day !== this.day) {
        this.day = day;
        await mkdir(this.dir, { recursive: true });
        await this.prune(day);
      }
      await appendFile(join(this.dir, `${day}.jsonl`), line);
    }).catch(error => this.log(`request log: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Resolves once every line written so far is on disk. */
  flushed(): Promise<void> {
    return this.pending;
  }

  private async prune(today: string): Promise<void> {
    const oldest = dayOf(Date.parse(today) - KEEP_DAYS * 86_400_000);
    for (const name of await readdir(this.dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < oldest) await rm(join(this.dir, name), { force: true });
    }
  }
}

/** The client samples of a POST /api/timings body; anything else in it is dropped. */
export function clientTimings(body: unknown): ClientTiming[] {
  const samples = (body as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(samples)) return [];
  return samples.filter((sample): sample is ClientTiming => {
    const { m, p, s, ms } = (sample ?? {}) as Record<string, unknown>;
    return typeof m === "string" && typeof p === "string" && p.startsWith("/api/") && typeof s === "number" && typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
  }).map(({ m, p, s, ms }) => ({ m, p: p.split("?")[0]!, s, ms }));
}
