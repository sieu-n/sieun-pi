import type { AgentConfig, AgentWake, ThreadKind } from "$lib/api";

/** A long list shows 10 rows and then a Show all control (owner rule c123). */
export const ROWS_SHOWN = 10;
export const capped = <T>(list: readonly T[], all: boolean): readonly T[] => (all ? list : list.slice(0, ROWS_SHOWN));

/** The 7 days split rows, in the order the tab lists the threads. */
export const USAGE_ROWS: readonly { kind: ThreadKind; label: string }[] = [
  { kind: "main", label: "Main thread" },
  { kind: "comm", label: "Comm threads" },
  { kind: "jobs", label: "Root jobs" },
];

const every = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  if (m === 1) return "every minute";
  return m >= 60 && m % 60 === 0 ? (m === 60 ? "every hour" : `every ${m / 60} hours`) : `every ${m} min`;
};

/** What a pending wake waits on, as one plain phrase: "at 14:40", "when CI run 123 ends" or "when its check passes or at 14:40, checked ...". */
export function wakeWhen(on: AgentWake["on"], stamp: (at: number) => string): string {
  if (on.kind === "time") return `at ${stamp(on.at)}`;
  if (on.kind === "run") return `when CI run ${on.run}${on.repo ? ` in ${on.repo}` : ""} ends`;
  return `when its check passes or at ${stamp(on.at)}, checked ${every(on.every)}`;
}

/** The main thread and each other kind with a turn or a cost in the 7 days, so a $0.00 row over no thread does not show. */
export function usageRows(usage: NonNullable<AgentConfig["usage"]>): { kind: ThreadKind; label: string; cost: number; turns: number; threads: number }[] {
  return USAGE_ROWS.map((row) => ({ ...row, ...usage.split[row.kind] })).filter((row) => row.kind === "main" || row.turns > 0 || row.cost > 0);
}
