/**
 * GET /api/usage sends each bucket's sums as one column per field. A 30-day report by hour on the rig's 5.0 M calls (11-24) held 720 bucket
 * objects with their key names, 42 KB of brotli, against 31 KB as columns; over the owner's 200 ms round trip each extra 15 to 20 KB costs
 * about one more trip (~/work/usage-one-source/usage-read-path/report.md). A bucket's start is `since` plus its index times the bucket's
 * length, since every bucket of a range has one length: minutes, hours, or Seoul days, which have no daylight saving.
 */
import type { UsageBucketSum, UsageReport } from "../types.ts";

const KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type Kind = (typeof KINDS)[number];

export interface UsageColumns {
  turns: number[]; unpriced: number[];
  tokens: Record<Kind, number[]>; cost: Record<Kind | "total", number[]>;
}
export type UsageReportWire = Omit<UsageReport, "buckets"> & { columns: UsageColumns };

export function toColumns(report: UsageReport): UsageReportWire {
  const { buckets, ...rest } = report;
  const column = (pick: (bucket: UsageBucketSum) => number): number[] => buckets.map(pick);
  return {
    ...rest,
    columns: {
      turns: column(b => b.turns), unpriced: column(b => b.unpriced),
      tokens: { input: column(b => b.tokens.input), output: column(b => b.tokens.output), cacheRead: column(b => b.tokens.cacheRead), cacheWrite: column(b => b.tokens.cacheWrite) },
      cost: {
        input: column(b => b.cost.input), output: column(b => b.cost.output), cacheRead: column(b => b.cost.cacheRead), cacheWrite: column(b => b.cost.cacheWrite),
        total: column(b => b.cost.total),
      },
    },
  };
}

/** The page's report from the answer. A report with `buckets` passes as it is: a server released before the columns sends those. */
export function fromColumns(answer: UsageReportWire | UsageReport): UsageReport {
  if (!("columns" in answer)) return answer;
  const { columns, ...rest } = answer;
  const step = columns.turns.length ? (answer.until - answer.since) / columns.turns.length : 0;
  const buckets = columns.turns.map((turns, i): UsageBucketSum => ({
    start: answer.since + i * step, turns, unpriced: columns.unpriced[i]!,
    tokens: { input: columns.tokens.input[i]!, output: columns.tokens.output[i]!, cacheRead: columns.tokens.cacheRead[i]!, cacheWrite: columns.tokens.cacheWrite[i]! },
    cost: {
      input: columns.cost.input[i]!, output: columns.cost.output[i]!, cacheRead: columns.cost.cacheRead[i]!, cacheWrite: columns.cost.cacheWrite[i]!,
      total: columns.cost.total[i]!,
    },
  }));
  return { ...rest, buckets };
}
