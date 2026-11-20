import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

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

const LEVEL = Buffer.from('{"type":"thinking_level_change"');

/**
 * The thinking level of the file's last thinking_level_change after byte `after`, read backwards CHUNK bytes at a time; `whole` says the read
 * started at the file's start, as it does when the file is now shorter than `after`. A saved thread wakes on that level (Prime's resume), and on
 * 11-20 long threads whose change sat before their first page showed "off" in the chat while they ran on high.
 */
export async function lastThinkingLevel(file: string, after = 0): Promise<{ size: number; whole: boolean; level: string | undefined }> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = after <= size ? after : 0;
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > start) {
      const from = Math.max(start, end - CHUNK);
      const chunk = Buffer.alloc(end - from);
      await handle.read(chunk, 0, chunk.length, from);
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      for (let at = data.lastIndexOf(LEVEL); at >= 0; at = at > 0 ? data.lastIndexOf(LEVEL, at - 1) : -1) {
        if (at > 0 ? data[at - 1] !== 0x0a : from > start) continue;
        const stop = data.indexOf(0x0a, at);
        const level = parsed(data.subarray(at, stop < 0 ? data.length : stop))?.thinkingLevel;
        if (typeof level === "string") return { size, whole: start === 0, level };
      }
      const firstLine = data.indexOf(0x0a);
      carry = data.subarray(0, firstLine < 0 ? data.length : firstLine);
      end = from;
    }
    return { size, whole: start === 0, level: undefined };
  } finally { await handle.close(); }
}
