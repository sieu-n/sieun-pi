import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** The bytes read at a time from a session file's end. A kill's archived state is the file's last line, so one read finds it. */
export const CHUNK = 256 * 1024;
export const STATE = Buffer.from('{"type":"session_state"');

export type Read = { fd: number; size: number };
export function readAt(file: Read, from: number, to: number): Buffer {
  const buffer = Buffer.alloc(to - from);
  let done = 0;
  while (done < buffer.length) {
    const got = readSync(file.fd, buffer, done, buffer.length - done, from + done);
    if (got === 0) break;
    done += got;
  }
  return buffer.subarray(0, done);
}

/** Each whole line of the file from its end backwards, CHUNK bytes per read, until `take` returns a value; undefined at the start of the file. */
export function fromEnd<T>(file: Read, take: (line: Buffer) => T | undefined): T | undefined {
  let end = file.size;
  let carry = Buffer.alloc(0);
  while (end > 0) {
    const from = Math.max(0, end - CHUNK);
    const buffer = Buffer.concat([readAt(file, from, end), carry]);
    let stop = buffer.length;
    for (let at = buffer.lastIndexOf(0x0a, stop - 1); ; at = buffer.lastIndexOf(0x0a, stop - 1)) {
      if (at < 0 && from > 0) { carry = buffer.subarray(0, stop); break; }
      const line = buffer.subarray(at + 1, stop);
      if (line.length) { const found = take(line); if (found !== undefined) return found; }
      if (at < 0) return undefined;
      stop = at;
    }
    end = from;
  }
  return undefined;
}

export const parsed = (line: Buffer): Record<string, unknown> | undefined => {
  try { const value: unknown = JSON.parse(line.toString("utf8")); return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined; }
  catch { return undefined; }
};

/** Prime's session_state statuses and whether each lists a saved session as archived (normalizeSessionStateStatus, inactiveLifecycleForSession). */
const ARCHIVED_STATUS: Readonly<Record<string, boolean>> = { active: false, archived: true, crash: true, hidden: true, sleep: true };

/**
 * Whether the daemon's full list would show this saved session file as archived: its last session_state with a status Prime knows is archived,
 * crash, hidden or sleep. False when the file is missing or has no such line, as the full list leaves a missing file out; null when it does not
 * read. One read from the end, where a kill or an archive writes its state, in place of the full list, which read 11,228 saved sessions
 * (97 MB, about 13 CPU-s of the supervisor's one thread) on 11-13.
 */
export function fileArchived(sessionFile: string): boolean | null {
  let fd: number;
  try { fd = openSync(sessionFile, "r"); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null; }
  try {
    return fromEnd({ fd, size: fstatSync(fd).size }, line => {
      if (!line.includes('"session_state"')) return undefined;
      const entry = parsed(line);
      const status = (entry?.state as { status?: unknown } | undefined)?.status;
      return entry?.type === "session_state" && typeof status === "string" ? ARCHIVED_STATUS[status] : undefined;
    }) ?? false;
  } catch { return null; } finally { closeSync(fd); }
}
