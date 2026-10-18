import { Transform } from "node:stream";

/**
 * The upgrade header a client sets on `GET /v1/daemon` to get each streamed `message_update` line as a delta against the session's previous one
 * (`encodeLineDeltas`), which the client turns back into the same bytes (`decodeLineDeltas`). This file imports nothing outside Node, because the
 * relay is installed alone.
 */
export const DELTA_HEADER = "x-prime-line-delta";
const DELTA_TYPE = "prime_relay_line_delta";
/** Long enough to hold `{"type":"session_event","activeSessionId":"<id>","event":{"type":"message_update"`. */
const HEAD_BYTES = 160;
const SESSION_LINE = /^\{"type":"session_event","activeSessionId":"([^"\\]+)","event":\{"type":"(message_update|message_end)"/;
const DELTA_LINE = /^\{"type":"prime_relay_line_delta","activeSessionId":"([^"\\]+)"/;
const NEWLINE = 10;
/** A copied run shorter than this costs more to name than to send. */
const ANCHOR = 16;
const SKIP_WINDOW = 256;
const MAX_OPS = 64;

/** `[start, length]` copies that many characters of the base line from `start`; a string goes in as it is. */
export type DeltaOp = [start: number, length: number] | string;

function sameRun(base: string, from: number, baseEnd: number, line: string, at: number, lineEnd: number): number {
  let length = 0;
  while (from + length < baseEnd && at + length < lineEnd && base.charCodeAt(from + length) === line.charCodeAt(at + length)) length++;
  return length;
}

/** The next place where base and line agree for ANCHOR characters: text added to the line before it, or base text the line dropped. */
function resync(base: string, from: number, baseEnd: number, line: string, at: number, lineEnd: number): { at: number; from: number } | null {
  if (from + ANCHOR <= baseEnd) {
    const found = line.indexOf(base.slice(from, from + ANCHOR), at);
    if (found >= 0 && found + ANCHOR <= lineEnd) return { at: found, from };
  }
  for (let skip = 0; skip <= SKIP_WINDOW && at + skip + ANCHOR <= lineEnd; skip += 4) {
    const found = base.indexOf(line.slice(at + skip, at + skip + ANCHOR), from);
    if (found >= 0 && found + ANCHOR <= baseEnd) return { at: at + skip, from: found };
  }
  return null;
}

/**
 * `line` as copies of `base` and inserted text. Consecutive message updates differ by the new token (in the message and in its event), the
 * usage numbers, the sequence and the time, so a 3.5 KB update becomes about 200 bytes.
 */
export function diffLine(base: string, line: string): DeltaOp[] {
  let suffix = 0;
  const most = Math.min(base.length, line.length);
  while (suffix < most && base.charCodeAt(base.length - 1 - suffix) === line.charCodeAt(line.length - 1 - suffix)) suffix++;
  const baseEnd = base.length - suffix;
  const lineEnd = line.length - suffix;
  const ops: DeltaOp[] = [];
  let at = 0;
  let from = 0;
  while (at < lineEnd) {
    const run = sameRun(base, from, baseEnd, line, at, lineEnd);
    if (run >= ANCHOR || (run > 0 && at === 0)) { ops.push([from, run]); from += run; at += run; continue; }
    const hit = ops.length < MAX_OPS ? resync(base, from, baseEnd, line, at, lineEnd) : null;
    if (!hit) { ops.push(line.slice(at, lineEnd)); break; }
    if (hit.at > at) ops.push(line.slice(at, hit.at));
    at = hit.at;
    from = hit.from;
  }
  if (suffix) ops.push([base.length - suffix, suffix]);
  return ops;
}

export function applyOps(base: string, ops: readonly DeltaOp[]): string {
  let line = "";
  for (const op of ops) line += typeof op === "string" ? op : base.slice(op[0], op[0] + op[1]);
  return line;
}

/**
 * A newline-framed byte stream where `wants` picks lines by their first HEAD_BYTES and `swap` replaces each picked line, newline included.
 * Every other line streams through as it arrives, so a multi-megabyte snapshot line is never held.
 */
function lineTransform(wants: (head: string) => boolean, swap: (line: Buffer) => Buffer): Transform {
  let mode: "start" | "pass" | "hold" = "start";
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const take = () => { const all = Buffer.concat(pending, pendingBytes); pending = []; pendingBytes = 0; return all; };
  return new Transform({
    transform(data: Buffer, _encoding, done) {
      try {
        let at = 0;
        while (at < data.length) {
          const end = data.indexOf(NEWLINE, at);
          const piece = data.subarray(at, end < 0 ? data.length : end + 1);
          at += piece.length;
          if (mode === "pass") { this.push(piece); if (end >= 0) mode = "start"; continue; }
          pending.push(piece);
          pendingBytes += piece.length;
          if (end >= 0) {
            const line = take();
            this.push(mode === "hold" || wants(line.subarray(0, HEAD_BYTES).toString("utf8")) ? swap(line) : line);
            mode = "start";
          } else if (mode === "start" && pendingBytes >= HEAD_BYTES) {
            const head = take();
            if (wants(head.subarray(0, HEAD_BYTES).toString("utf8"))) { pending = [head]; pendingBytes = head.length; mode = "hold"; }
            else { this.push(head); mode = "pass"; }
          }
        }
        done();
      } catch (error) { done(error as Error); }
    },
    flush(done) { if (pendingBytes) this.push(take()); done(); },
  });
}

/**
 * The daemon-to-client stream with each `message_update` line sent as a delta against the previous `message_update` line of the same session,
 * when that is shorter. The Mac daemon sends one update per token, each with the whole partial message: on 10-18 a 6 KB reply was 448 updates and
 * 1.73 MB, about 90 KB as deltas. The first update of a session and the first after its `message_end` go whole, and so does a line that is not
 * valid UTF-8, so the client can always rebuild the exact bytes.
 */
export function encodeLineDeltas(): Transform {
  const bases = new Map<string, string>();
  return lineTransform(head => SESSION_LINE.test(head), line => {
    const [, id = "", type] = SESSION_LINE.exec(line.subarray(0, HEAD_BYTES).toString("utf8")) ?? [];
    if (type === "message_end" || line.at(-1) !== NEWLINE) { bases.delete(id); return line; }
    const text = line.toString("utf8", 0, line.length - 1);
    const base = bases.get(id);
    bases.set(id, text);
    if (base === undefined || !Buffer.from(text).equals(line.subarray(0, line.length - 1))) return line;
    const ops = diffLine(base, text);
    const delta = JSON.stringify({ type: DELTA_TYPE, activeSessionId: id, ops });
    return delta.length < text.length && applyOps(base, ops) === text ? Buffer.from(delta + "\n") : line;
  });
}

/** The client side of `encodeLineDeltas`: it rebuilds each delta line from the previous update of its session and passes every other byte as it came. */
export function decodeLineDeltas(): Transform {
  const bases = new Map<string, string>();
  return lineTransform(head => DELTA_LINE.test(head) || SESSION_LINE.test(head), line => {
    const head = line.subarray(0, HEAD_BYTES).toString("utf8");
    const session = SESSION_LINE.exec(head);
    if (session) {
      const id = session[1]!;
      if (session[2] === "message_end" || line.at(-1) !== NEWLINE) bases.delete(id);
      else bases.set(id, line.toString("utf8", 0, line.length - 1));
      return line;
    }
    const delta = JSON.parse(line.toString("utf8")) as { activeSessionId: string; ops: DeltaOp[] };
    const base = bases.get(delta.activeSessionId);
    if (base === undefined) throw new Error(`a line delta for session ${delta.activeSessionId} came with no earlier update to apply it to`);
    const text = applyOps(base, delta.ops);
    bases.set(delta.activeSessionId, text);
    return Buffer.from(text + "\n");
  });
}
