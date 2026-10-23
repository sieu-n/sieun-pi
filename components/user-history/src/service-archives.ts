import { type JsonFile, snapshotJsonFile, transactJsonFile } from "./locked-json.ts";

/**
 * The chat service's own archives and stops of sessions, apart from the owner's. Prime's daemon writes the reason on the archived session_state
 * line itself and takes none from a client: a bare `kill` reads `owner_stop`, `kill` with origin `idle_unload` reads `idle_unload`, and
 * `archive_saved_session` always reads `owner_archive` (Prime 0.9.8 dhx.3). So on 10-20 the duty runner's archive of each cut duty job, 0.4 to
 * 3 s after "its turn ended; queued its archive" in service.log, read as the owner's archive to every reader of the session file.
 *
 * Each archive the service sends is one operation here. Before the command goes out, the service records the operation with the id of the
 * session file's last entry (`after`). Once the daemon confirms the command, it records the id of the one archived line written after that
 * entry (`line`). A reader takes only that exact line as the service's, never a line it matches by time or by session: a refused or failed
 * send records no line and covers nothing, and any later owner stop or archive is a line of its own, so it stays the owner's. The owner's own
 * archive through the service drops the session's operations.
 */
export type ServiceArchiveReason =
  /** The duty runner's archive of a duty job whose turn ended, cut or done, or whose register or brief failed (the duty archive queue). */
  | "duty_job_end"
  /** A chat's sweep of an idle root job that no open step names (`Chats.endIdleRoots`). */
  | "idle_root_end"
  /** A chat's sweep of a root the cleanup started whose steps now name other workers (`Chats.retireReplaced`). */
  | "replaced_job_end"
  /** The service's stop of a session it made for itself: a spare, a create whose rename or account use failed. */
  | "service_cleanup";
export type ArchiveBy = "owner" | ServiceArchiveReason;
export const SERVICE_ARCHIVE_REASONS: readonly ServiceArchiveReason[] = ["duty_job_end", "idle_root_end", "replaced_job_end", "service_cleanup"];
export const isServiceArchiveReason = (value: unknown): value is ServiceArchiveReason => SERVICE_ARCHIVE_REASONS.includes(value as ServiceArchiveReason);

export interface ServiceArchive {
  /** This operation's own id. */
  op: string;
  /** When the service recorded it, before the command went out. */
  at: number;
  reason: ServiceArchiveReason;
  /** The id of the session file's last entry before the command went out; null when this box could not read the file. */
  after: string | null;
  /** The id of the archived session_state line the confirmed command wrote; null while unconfirmed, refused, failed or not found. */
  line: string | null;
}
export const SERVICE_ARCHIVES_FILE = "service-archives.json";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const idOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

function parseOperation(value: unknown): ServiceArchive[] {
  if (!isRecord(value) || typeof value.op !== "string" || typeof value.at !== "number" || !isServiceArchiveReason(value.reason) || !idOrNull(value.after) || !idOrNull(value.line)) return [];
  return [{ op: value.op, at: value.at, reason: value.reason, after: value.after, line: value.line }];
}

/**
 * `{ [session id]: ServiceArchive[] }` from the file's JSON. Entries that do not parse are dropped, such as 4ec60673's `{ at, reason }`, which
 * names no line and so covers nothing.
 */
export function parseServiceArchives(value: unknown): Record<string, ServiceArchive[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, entries]) => {
    const operations = Array.isArray(entries) ? entries.flatMap(parseOperation) : [];
    return operations.length ? [[id, operations]] : [];
  }));
}

export interface ServiceArchiveRecord {
  /** Records the service's archive or stop of `id`, before it goes out. */
  add(id: string, entry: ServiceArchive): Promise<void>;
  /** The daemon confirmed operation `op` of `id`, and `line` is the archived line it wrote. */
  land(id: string, op: string, line: string): Promise<void>;
  /** The owner archived `id` himself: no earlier service archive of it stands. */
  drop(id: string): Promise<void>;
  of(id: string): Promise<readonly ServiceArchive[]>;
}

/** `<data dir>/service-archives.json`, written whole by rename under its lock, so a reader without the lock sees a whole file. */
export function serviceArchiveRecord(path: string): ServiceArchiveRecord {
  const file: JsonFile<Record<string, ServiceArchive[]>> = { path, label: "Service archive record", initial: () => ({}), parse: parseServiceArchives };
  return {
    async add(id, entry) { await transactJsonFile(file, state => { state[id] = [...state[id] ?? [], entry]; }); },
    async land(id, op, line) { await transactJsonFile(file, state => { for (const entry of state[id] ?? []) if (entry.op === op) entry.line = line; }); },
    async drop(id) { await transactJsonFile(file, state => { delete state[id]; }); },
    async of(id) { return (await snapshotJsonFile(file))[id] ?? []; },
  };
}

/** The archived lines the service's own confirmed archives wrote, by line id. */
export const serviceArchiveLines = (operations: readonly ServiceArchive[]): ReadonlySet<string> =>
  new Set(operations.flatMap(entry => entry.line === null ? [] : [entry.line]));
