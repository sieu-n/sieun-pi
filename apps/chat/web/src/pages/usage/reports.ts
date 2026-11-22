/**
 * The Usage page's reports, kept by range, grouping, chat and host for as long as the page lives, and read ahead for the other choices,
 * so a pick shows its chart at once. The owner reads :5184 from Korea at a 200 ms round trip: on 11-21 his GET /api/usage calls took 420
 * to 640 ms at each pick of a range (requests/2026-11-21.jsonl), since a 27 to 75 KB answer after an idle second goes back to TCP slow
 * start and takes two or three round trips (~/work/p188-usage). The server answered them in 5 to 40 ms.
 *
 * A report is current for `REFRESH_MS` after its read left, the page's own refresh period, as the page shows every answer that long
 * between its refreshes. A pick of a current report reads nothing, so the reads ahead do not wait behind refreshes in the lane
 * (client.ts). Each call's line says what the screen did (client.ts `Wait`): `ahead` for a read no view shows yet, `shown` for a refresh
 * behind a report the page shows, and a wait for the rest.
 */
import { api, takeOver, type Wait } from "$lib/api/client";
import { RANGE_BUCKETS, USAGE_RANGES } from "$lib/api/shared/usage-range";
import type { UsageBucket, UsageRange, UsageReport } from "$lib/api/types";

export type UsageFilters = { range: UsageRange; bucket: UsageBucket; thread?: string; host?: string };

/** The page's refresh period, and how long a kept report counts as current. */
export const REFRESH_MS = 60_000;

/** A report and when its read left the page (`performance.now()`). */
export type KeptReport = { report: UsageReport; read: number };
type Flight = { promise: Promise<KeptReport>; wait: Wait };

const kept = new Map<string, KeptReport>();
const flights = new Map<string, Flight>();
const keyOf = (filters: UsageFilters): string => JSON.stringify([filters.range, filters.bucket, filters.thread ?? "", filters.host ?? ""]);
const current = (entry: KeptReport | undefined): boolean => !!entry && performance.now() - entry.read < REFRESH_MS;

function fetchReport(filters: UsageFilters, wait: Wait): Promise<KeptReport> {
  const key = keyOf(filters);
  const left = performance.now();
  const promise = api.usage(filters, wait).then(report => {
    const entry = { report, read: left };
    kept.set(key, entry);
    return entry;
  }).finally(() => {
    if (flights.get(key)?.promise === promise) flights.delete(key);
  });
  flights.set(key, { promise, wait });
  return promise;
}

/** The report the page last read for these filters, current or not, to show while the next one comes. */
export const keptReport = (filters: UsageFilters): UsageReport | null => kept.get(keyOf(filters))?.report ?? null;

/**
 * What asks for a report: a view that shows it, the page's own refresh behind the report it shows (`poll`), or the owner's Refresh, which
 * he waits on (`force`).
 */
export type ReadMode = "view" | "poll" | "force";

/**
 * The report for `mode`. A view takes a current kept report with no read, and the page refreshes it once it is `REFRESH_MS` old, as it
 * refreshes every report it shows. A read ahead on its way serves the call and from then on counts as his wait, or as a refresh behind
 * the kept report when that is current or the call is a poll.
 */
export function readReport(filters: UsageFilters, mode: ReadMode = "view"): Promise<KeptReport> {
  const have = kept.get(keyOf(filters));
  if (mode === "view" && have && current(have)) return Promise.resolve(have);
  const shown = mode === "poll" || (mode === "view" && current(have));
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
