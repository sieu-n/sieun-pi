/**
 * The Usage page's reports, kept by range, grouping, chat and host for as long as the page lives, and read ahead for the other choices,
 * so a pick shows its chart at once. The owner reads :5184 from Korea at a 200 ms round trip: on 11-21 his GET /api/usage calls took 420
 * to 640 ms at each pick of a range (requests/2026-11-21.jsonl), since a 27 to 75 KB answer after an idle second goes back to TCP slow
 * start and takes two or three round trips (~/work/p188-usage). The server answered them in 5 to 40 ms.
 *
 * Each call's line says what the screen did (client.ts `Wait`): `ahead` for a read no view shows yet, `shown` for a refresh behind a
 * report the page already showed while it was current, and a wait for the rest. A report is current for `REFRESH_MS` after its read left,
 * the page's own refresh period, as the page shows every answer that long between its refreshes.
 */
import { api, takeOver, type Wait } from "$lib/api/client";
import { RANGE_BUCKETS, USAGE_RANGES } from "$lib/api/shared/usage-range";
import type { UsageBucket, UsageRange, UsageReport } from "$lib/api/types";

export type UsageFilters = { range: UsageRange; bucket: UsageBucket; thread?: string; host?: string };

/** The page's refresh period, and how long a kept report counts as current. */
export const REFRESH_MS = 60_000;

type KeptReport = { report: UsageReport; read: number };
type Flight = { promise: Promise<UsageReport>; wait: Wait };

const kept = new Map<string, KeptReport>();
const flights = new Map<string, Flight>();
const keyOf = (filters: UsageFilters): string => JSON.stringify([filters.range, filters.bucket, filters.thread ?? "", filters.host ?? ""]);
const current = (entry: KeptReport | undefined): boolean => !!entry && performance.now() - entry.read < REFRESH_MS;

function fetchReport(filters: UsageFilters, wait: Wait): Promise<UsageReport> {
  const key = keyOf(filters);
  const left = performance.now();
  const promise = api.usage(filters, wait).then(report => {
    kept.set(key, { report, read: left });
    return report;
  }).finally(() => {
    if (flights.get(key)?.promise === promise) flights.delete(key);
  });
  flights.set(key, { promise, wait });
  return promise;
}

/** The report the page last read for these filters, current or not, to show while the next one comes. */
export const keptReport = (filters: UsageFilters): UsageReport | null => kept.get(keyOf(filters))?.report ?? null;

/**
 * Reads the report a view shows. A read ahead on its way serves it and from then on counts as the view's wait, or as a refresh behind it
 * when the kept report is current. `poll` is the page's own refresh behind the report it shows.
 */
export function readReport(filters: UsageFilters, poll = false): Promise<UsageReport> {
  const shown = poll || current(kept.get(keyOf(filters)));
  const flight = flights.get(keyOf(filters));
  if (flight) {
    if (flight.wait.background === "ahead") takeOver(flight.wait, shown ? "shown" : undefined);
    return flight.promise;
  }
  return fetchReport(filters, shown ? { background: "shown" } : {});
}

/** Reads ahead every other range and grouping for the same chat and host whose kept report is not current, while the page is in view. */
export function readAhead(filters: UsageFilters): void {
  if (typeof document !== "undefined" && document.hidden) return;
  for (const range of USAGE_RANGES) {
    for (const bucket of RANGE_BUCKETS[range]) {
      const other = { ...filters, range, bucket };
      const key = keyOf(other);
      if (key === keyOf(filters) || flights.has(key) || current(kept.get(key))) continue;
      fetchReport(other, { background: "ahead" }).catch(() => undefined);
    }
  }
}
