import { type JsonFile, snapshotJsonFile, transactJsonFile } from "./locked-json.ts";

/**
 * The chat service's own archives and stops of sessions, apart from the owner's. Prime's daemon writes the reason on the archived session_state
 * line itself and takes none from a client: a bare `kill` reads `owner_stop`, `kill` with origin `idle_unload` reads `idle_unload`, and
 * `archive_saved_session` always reads `owner_archive` (Prime 0.9.8 dhx.3). So on 10-20 the duty runner's archive of each cut duty job, 0.4 to
 * 3 s after "its turn ended; queued its archive" in service.log, read as the owner's archive to every reader of the session file. The service
 * writes its reason here before it sends the archive, and a reader takes an owner_stop or owner_archive line stamped at or after the entry, with no
 * active line between, as this archive. The owner's own archive through the service drops the entry, so his archive reads as his again.
 */
export type ServiceArchiveReason =
  /** The duty runner's archive of a duty job whose turn ended, cut or done, or whose register or brief failed (the duty archive queue). */
  | "duty_job_end"
  /** A chat's sweep of an idle root job that no open step names (`Chats.endIdleRoots`). */
  | "idle_root_end"
  /** The service's stop of a session it made for itself: a spare, a create whose rename or account use failed. */
  | "service_cleanup";
export type ArchiveBy = "owner" | ServiceArchiveReason;
export const SERVICE_ARCHIVE_REASONS: readonly ServiceArchiveReason[] = ["duty_job_end", "idle_root_end", "service_cleanup"];
export const isServiceArchiveReason = (value: unknown): value is ServiceArchiveReason => SERVICE_ARCHIVE_REASONS.includes(value as ServiceArchiveReason);

export interface ServiceArchive { at: number; reason: ServiceArchiveReason }
export const SERVICE_ARCHIVES_FILE = "service-archives.json";
/**
 * An archive line up to this long before the entry's own time still belongs to it: the entry is written before the archive, but a session on
 * another box gets its line stamped by that box's clock. The same slack as job-cancels.ts CANCEL_CLOCK_SLACK_MS.
 */
export const SERVICE_ARCHIVE_CLOCK_SLACK_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `{ [session id]: ServiceArchive }` from the file's JSON; entries that do not parse are dropped. */
export function parseServiceArchives(value: unknown): Record<string, ServiceArchive> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, entry]) =>
    isRecord(entry) && typeof entry.at === "number" && isServiceArchiveReason(entry.reason) ? [[id, { at: entry.at, reason: entry.reason }]] : []));
}

export interface ServiceArchiveRecord {
  /** Records the service's archive or stop of `id`, before it goes out. */
  add(id: string, entry: ServiceArchive): Promise<void>;
  /** The owner archived `id` himself: his archive is no longer the service's. */
  drop(id: string): Promise<void>;
  of(id: string): Promise<ServiceArchive | undefined>;
}

/** `<data dir>/service-archives.json`, written whole by rename under its lock, so a reader without the lock sees a whole file. */
export function serviceArchiveRecord(path: string): ServiceArchiveRecord {
  const file: JsonFile<Record<string, ServiceArchive>> = { path, label: "Service archive record", initial: () => ({}), parse: parseServiceArchives };
  return {
    async add(id, entry) { await transactJsonFile(file, state => { state[id] = entry; }); },
    async drop(id) { await transactJsonFile(file, state => { delete state[id]; }); },
    async of(id) { return (await snapshotJsonFile(file))[id]; },
  };
}

/** Whether an archived session_state line stamped `at` is the service's archive `entry`, given the last active line's stamp before it. */
export const serviceArchiveLine = (at: number, lastActive: number, entry: ServiceArchive | undefined): boolean =>
  entry !== undefined && at >= entry.at - SERVICE_ARCHIVE_CLOCK_SLACK_MS && !(lastActive >= entry.at);
