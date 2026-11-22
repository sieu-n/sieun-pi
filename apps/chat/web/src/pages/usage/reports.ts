/**
 * The Usage page's reports, kept by range, grouping, chat and host for as long as the page lives, and read ahead for the other choices,
 * so a pick shows its chart at once. The owner reads :5184 from Korea at a 200 ms round trip: on 11-21 his GET /api/usage calls took 420
 * to 640 ms at each pick of a range (requests/2026-11-21.jsonl), since a 27 to 75 KB answer after an idle second goes back to TCP slow
 * start and takes two or three round trips (~/work/p188-usage). The server answered them in 5 to 40 ms.
 *
 * A report is current for `REFRESH_MS` after its read left, the page's own refresh period, as the page shows every answer that long
 * between its refreshes. A pick of a current report reads nothing, so the reads ahead do not wait behind refreshes in the lane
 * (client.ts). A report that is not current shows at once with the time it is as of, and the read behind it is a refresh. Each call's
 * line says what the screen did (client.ts `Wait`): `ahead` for a read no view shows yet, `shown` for a refresh behind a report the page
 * shows, and a wait for the rest.
 *
 * The reports the page showed with no chat or host filter are also kept in IndexedDB, one per range and grouping, so the first open after
 * a page load draws the last one at once: on 11-22 that open still waited 280 to 450 ms for its 37 KB answer, two round trips of slow start
 * (~/work/p188-usage/summary.md).
 */
import { api, takeOver, type Wait } from "$lib/api/client";
import { RANGE_BUCKETS, USAGE_RANGES } from "$lib/api/shared/usage-range";
import type { UsageBucket, UsageRange, UsageReport } from "$lib/api/types";

export type UsageFilters = { range: UsageRange; bucket: UsageBucket; thread?: string; host?: string };

/** The page's refresh period, and how long a kept report counts as current. */
export const REFRESH_MS = 60_000;

/** A report and when its read left the page (`performance.now()`), or -Infinity for one an earlier page load kept. */
export type KeptReport = { report: UsageReport; read: number };
type Flight = { promise: Promise<KeptReport>; wait: Wait };

const kept = new Map<string, KeptReport>();
const flights = new Map<string, Flight>();
const keyOf = (filters: UsageFilters): string => JSON.stringify([filters.range, filters.bucket, filters.thread ?? "", filters.host ?? ""]);
const current = (entry: KeptReport | undefined): boolean => !!entry && performance.now() - entry.read < REFRESH_MS;
/** Where a report with no chat or host filter is stored, else null. */
const storedKey = (filters: UsageFilters): string | null => (filters.thread || filters.host ? null : `${filters.range}:${filters.bucket}`);

/** The IndexedDB store of the reports, apart from page-db.ts, whose every kept page each page load reads before it mounts. */
const DB = "chat.usage";
const STORE = "reports";
let opened: Promise<IDBDatabase> | undefined;

function stores(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open"));
    request.onblocked = () => reject(new Error("IndexedDB is held by an older tab"));
  });
  return opened.then(db => db.transaction(STORE, mode).objectStore(STORE));
}

const isReport = (value: unknown): value is UsageReport => {
  const report = value as Partial<UsageReport> | null;
  return typeof report?.at === "number" && Array.isArray(report.rows) && Array.isArray(report.buckets);
};

/** The stored report of `key`, or null; every failure, IndexedDB closed to the page included, reads as none. */
function stored(key: string): Promise<UsageReport | null> {
  return stores("readonly").then(store => new Promise<UsageReport | null>(resolve => {
    const request = store.get(key);
    request.onsuccess = () => resolve(isReport(request.result) ? request.result : null);
    request.onerror = () => resolve(null);
  }), () => null);
}

function store(key: string, report: UsageReport): void {
  void stores("readwrite").then(store => void store.put(report, key), () => undefined);
}

function fetchReport(filters: UsageFilters, wait: Wait, keep: boolean): Promise<KeptReport> {
  const key = keyOf(filters);
  const left = performance.now();
  const promise = api.usage(filters, wait).then(report => {
    const entry = { report, read: left };
    kept.set(key, entry);
    const at = storedKey(filters);
    if (keep && at) store(at, report);
    return entry;
  }).finally(() => {
    if (flights.get(key)?.promise === promise) flights.delete(key);
  });
  flights.set(key, { promise, wait });
  return promise;
}

/** The report the page last read for these filters, current or not, to show while the next one comes. */
export const keptReport = (filters: UsageFilters): UsageReport | null => kept.get(keyOf(filters))?.report ?? null;

/** Whether a view of these filters reads nothing, its kept report being current. */
export const isCurrent = (filters: UsageFilters): boolean => current(kept.get(keyOf(filters)));

/** The kept report of the filters, else the one an earlier page load stored, which is then kept as not current. */
export async function restoreReport(filters: UsageFilters): Promise<UsageReport | null> {
  const have = keptReport(filters);
  const at = storedKey(filters);
  if (have || !at) return have;
  const report = await stored(at);
  if (report && !kept.has(keyOf(filters))) kept.set(keyOf(filters), { report, read: -Infinity });
  return keptReport(filters);
}

/**
 * What asks for a report: a view that shows it, the page's own refresh behind the report it shows (`poll`), or the owner's Refresh, which
 * he waits on (`force`).
 */
export type ReadMode = "view" | "poll" | "force";

/**
 * The report for `mode`. A view takes a current kept report with no read, and the page refreshes it once it is `REFRESH_MS` old, as it
 * refreshes every report it shows. A view of a kept report that is not current reads behind it as a refresh, since the page shows that
 * report with its time. A read ahead on its way serves the call and from then on counts as his wait, or as a refresh behind a kept report.
 */
export function readReport(filters: UsageFilters, mode: ReadMode = "view"): Promise<KeptReport> {
  const have = kept.get(keyOf(filters));
  if (mode === "view" && have && current(have)) return Promise.resolve(have);
  const shown = mode === "poll" || (mode === "view" && !!have);
  const flight = flights.get(keyOf(filters));
  if (flight) {
    if (flight.wait.background === "ahead") takeOver(flight.wait, shown ? "shown" : undefined);
    return flight.promise;
  }
  return fetchReport(filters, shown ? { background: "shown" } : {}, true);
}

/**
 * Reads ahead every other range and grouping for the same chat and host whose kept report is not current, while the page is in view.
 * They are reads for the page he looks at (`Wait.first`), so the lane sends them before the sidebar's: in a walk on 11-22 the first load
 * of the app on the Usage page queued them behind its rooms and boards, and 7 picks in 30 s found no kept report and waited 435 to 889 ms.
 */
export function readAhead(filters: UsageFilters): void {
  if (typeof document !== "undefined" && document.hidden) return;
  for (const range of USAGE_RANGES) {
    for (const bucket of RANGE_BUCKETS[range]) {
      const other = { ...filters, range, bucket };
      const key = keyOf(other);
      if (key === keyOf(filters) || flights.has(key) || current(kept.get(key))) continue;
      fetchReport(other, { background: "ahead", first: true }, false).catch(() => undefined);
    }
  }
}

/** The page's first view: 24h by the hour with no filter. */
const FIRST: UsageFilters = { range: "24h", bucket: "hour" };

/**
 * A browser with no stored first view reads it ahead through the lane, behind every call he waits on (client.ts), and stores it, so even
 * its first open of the page draws a report at once. A browser that stored one reads nothing.
 */
export function storeFirstViewAhead(): void {
  void stored(storedKey(FIRST)!).then(report => {
    if (report || kept.has(keyOf(FIRST)) || flights.has(keyOf(FIRST))) return;
    fetchReport(FIRST, { background: "ahead" }, true).catch(() => undefined);
  });
}
