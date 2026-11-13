import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { CURRENT_SESSION_VERSION, SessionManager } from "prime-agent";
import { CHUNK, fromEnd, parsed, readAt, STATE, type Read } from "./session-file-end.ts";

/** Each file's last queued state write; a write starts after the one before it on the same file ends, so they land in call order. */
const queued = new Map<string, Promise<void>>();

/**
 * Writes a closed session file's lifecycle state, as `SessionManager.open(file)` with `getSessionState` and `appendSessionState` does, without
 * parsing the transcript: the state is the file's last session_state line and the new entry's parent its last entry. A file of another
 * version or with a cut last line takes the full open, which migrates and repairs it. On 10-19 the idle unload's sweep opened every session
 * it stopped this way, up to 60 MB in one sweep, and a 73 MB chat took 0.48 s of the service's main thread to open.
 *
 * The append runs on libuv's pool, and the promise settles once the line is in the file. On 11-04 at 05:02:10Z an appendFileSync here held
 * the main thread 2.0 s in the kernel. A call queues behind the file's earlier calls, so a caller that queues synchronously after a check
 * keeps its order against a later archive's write.
 */
export function setFileSessionState(sessionFile: string, status: "archived" | "active"): Promise<void> {
  const write = (queued.get(sessionFile) ?? Promise.resolve()).then(() => writeState(sessionFile, status));
  const settled = write.then(() => {}, () => {});
  queued.set(sessionFile, settled);
  void settled.then(() => { if (queued.get(sessionFile) === settled) queued.delete(sessionFile); });
  return write;
}

async function writeState(sessionFile: string, status: "archived" | "active"): Promise<void> {
  const fd = openSync(sessionFile, "r");
  let fast: { current: string | undefined; leaf: string } | undefined;
  try {
    const file = { fd, size: fstatSync(fd).size };
    const head = fromStart(file);
    const whole = file.size > 0 && readAt(file, file.size - 1, file.size)[0] === 0x0a;
    if (head?.type === "session" && head.version === CURRENT_SESSION_VERSION && whole) {
      const leaf = fromEnd(file, line => { const entry = parsed(line); return entry && entry.type !== "session" && typeof entry.id === "string" ? entry.id : undefined; });
      const current = fromEnd(file, line => {
        if (!line.subarray(0, STATE.length).equals(STATE)) return undefined;
        const state = parsed(line)?.state as { status?: unknown } | undefined;
        return typeof state?.status === "string" ? state.status : undefined;
      });
      if (leaf) fast = { current, leaf };
    }
  } finally { closeSync(fd); }
  if (!fast) {
    const manager = SessionManager.open(sessionFile);
    const current = manager.getSessionState()?.status;
    if (status === "archived" ? current !== "archived" : current === "archived") manager.appendSessionState(status === "archived" ? { status, reason: undefined } : { status });
    return;
  }
  if (status === "archived" ? fast.current === "archived" : fast.current !== "archived") return;
  await appendFile(sessionFile, JSON.stringify({ type: "session_state", id: randomUUID(), parentId: fast.leaf, timestamp: new Date().toISOString(), state: { status } }) + "\n");
}

/** The id of the session file's last whole entry, or null when the file is missing or its last whole line has none. */
export function lastEntryId(sessionFile: string): string | null {
  let fd: number;
  try { fd = openSync(sessionFile, "r"); } catch { return null; }
  try {
    const file = { fd, size: fstatSync(fd).size };
    const whole = file.size > 0 && readAt(file, file.size - 1, file.size)[0] === 0x0a;
    let first = !whole;
    const id = fromEnd(file, line => {
      if (first) { first = false; return undefined; }
      const value = parsed(line)?.id;
      return typeof value === "string" ? value : null;
    });
    return id ?? null;
  } finally { closeSync(fd); }
}

/** The ids of the archived session_state lines after the entry `after`, oldest first; null when `after` is not in the file. */
export function archivedLinesAfter(sessionFile: string, after: string): string[] | null {
  const fd = openSync(sessionFile, "r");
  try {
    const file = { fd, size: fstatSync(fd).size };
    const archived: string[] = [];
    const found = fromEnd(file, line => {
      const entry = parsed(line);
      if (entry?.id === after) return true;
      const state = entry?.state as { status?: unknown } | undefined;
      if (entry?.type === "session_state" && state?.status === "archived" && typeof entry.id === "string") archived.unshift(entry.id);
      return undefined;
    });
    return found ? archived : null;
  } finally { closeSync(fd); }
}

/** The file's first line, parsed; undefined when it does not end within CHUNK bytes or does not parse. */
function fromStart(file: Read): Record<string, unknown> | undefined {
  const buffer = readAt(file, 0, Math.min(file.size, CHUNK));
  const end = buffer.indexOf(0x0a);
  return end < 0 ? undefined : parsed(buffer.subarray(0, end));
}
