/**
 * api/usage's answers kept between changes of the sums. A 30-day report by hour took 31 to 46 ms to build from the kept sums and 102 ms at
 * box load 90 on 11-24, against about 22 ms from pi-host before, so from Korea it came 48 ms slower at p50. The sums change at one 2 s pull
 * in seven (41 of 300 on 11-24), so each answer asked for in the last day is built again off the request path after such a pull, and a call
 * gets it as it is until the sums change again or its last bucket ends.
 */
import type { Threads } from "./threads.ts";
import { usageReport, type UsageReportOptions } from "./usage.ts";
import { USAGE_PULL_MS, type UsageSums } from "./usage-store.ts";
import { toColumns, type UsageReportWire } from "../web/src/lib/api/shared/usage-columns.ts";

/** How long an answer nobody asks for again is still built after each change: the page's day of use. */
const ASKED_KEPT_MS = 86_400_000;

type Kept = { opts: UsageReportOptions; version: number; until: number; answer: Promise<UsageReportWire>; askedAt: number };

export class UsageAnswers {
  private readonly kept = new Map<string, Kept>();
  private readonly sums: UsageSums;
  private readonly threads: Threads;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private building = false;

  constructor(sums: UsageSums, threads: Threads, now: () => number = Date.now) {
    this.sums = sums;
    this.threads = threads;
    this.now = now;
  }

  /** Checks the kept answers each pull and builds again those the sums or the clock outdated. A store with no version keeps nothing. */
  start(ms = USAGE_PULL_MS): void {
    if (!this.sums.version) return;
    this.timer = setInterval(() => void this.rebuild(), ms);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async report(opts: UsageReportOptions): Promise<UsageReportWire> {
    if (!this.sums.version) return toColumns(await usageReport(this.sums, this.threads, opts));
    const key = JSON.stringify([opts.range, opts.bucket, opts.split, opts.thread, opts.host, opts.client]);
    const now = this.now();
    const kept = this.kept.get(key);
    if (kept) kept.askedAt = now;
    if (kept && this.good(kept, now)) return kept.answer;
    return this.build(key, opts, now).answer;
  }

  private good(kept: Kept, now: number): boolean {
    return kept.version === this.sums.version!() && now < kept.until;
  }

  private build(key: string, opts: UsageReportOptions, now: number, askedAt = now): Kept {
    const version = this.sums.version!();
    const report = usageReport(this.sums, this.threads, opts, now);
    const answer = report.then(toColumns);
    const kept: Kept = { opts, version, until: Infinity, answer, askedAt };
    this.kept.set(key, kept);
    // A failed build is not kept, so the next call tries again.
    report.then(r => { kept.until = r.until; }, () => { if (this.kept.get(key) === kept) this.kept.delete(key); });
    return kept;
  }

  /** Builds each answer asked for in the last day again, one per turn of the event loop, once the sums changed or its last bucket ended. */
  private async rebuild(): Promise<void> {
    if (this.building) return;
    this.building = true;
    try {
      for (const [key, kept] of [...this.kept]) {
        const now = this.now();
        if (now - kept.askedAt > ASKED_KEPT_MS) {
          this.kept.delete(key);
          continue;
        }
        if (this.good(kept, now)) continue;
        await new Promise(resolve => setImmediate(resolve));
        await this.build(key, kept.opts, now, kept.askedAt).answer.catch(() => undefined);
      }
    } finally {
      this.building = false;
    }
  }
}
