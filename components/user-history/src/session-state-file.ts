import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { CURRENT_SESSION_VERSION, SessionManager } from "prime-agent";

/** The bytes read at a time from a session file's end. A kill's archived state is the file's last line, so one read finds it. */
const CHUNK = 256 * 1024;
const STATE = Buffer.from('{"type":"session_state"');

type Read = { fd: number; size: number };
function readAt(file: Read, from: number, to: number): Buffer {
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
function fromEnd<T>(file: Read, take: (line: Buffer) => T | undefined): T | undefined {
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

const parsed = (line: Buffer): Record<string, unknown> | undefined => {
  try { const value: unknown = JSON.parse(line.toString("utf8")); return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined; }
  catch { return undefined; }
};

/**
 * Writes a closed session file's lifecycle state, as `SessionManager.open(file)` with `getSessionState` and `appendSessionState` does, without
 * parsing the transcript: the state is the file's last session_state line and the new entry's parent its last entry. A file of another
 * version or with a cut last line takes the full open, which migrates and repairs it. On 10-19 the idle unload's sweep opened every session
 * it stopped this way, up to 60 MB in one sweep, and a 73 MB chat took 0.48 s of the service's main thread to open.
 */
export function setFileSessionState(sessionFile: string, status: "archived" | "active"): void {
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
    if (status === "archived" ? current !== "archived" : current === "archived") manager.appendSessionState({ status });
    return;
  }
  if (status === "archived" ? fast.current === "archived" : fast.current !== "archived") return;
  appendFileSync(sessionFile, JSON.stringify({ type: "session_state", id: randomUUID(), parentId: fast.leaf, timestamp: new Date().toISOString(), state: { status } }) + "\n");
}

/** The file's first line, parsed; undefined when it does not end within CHUNK bytes or does not parse. */
function fromStart(file: Read): Record<string, unknown> | undefined {
  const buffer = readAt(file, 0, Math.min(file.size, CHUNK));
  const end = buffer.indexOf(0x0a);
  return end < 0 ? undefined : parsed(buffer.subarray(0, end));
}
