import { open, type FileHandle } from "node:fs/promises";

/**
 * Appended-bytes reader for JSONL transcripts. Most lines carry no usage, so lines are picked by a byte pattern before
 * any JSON.parse: a `within` needle must start in the first `within` bytes of the line (one memchr pass for the line
 * ends, then a short look at each line head); a needle without `within` is searched anywhere in the chunk.
 * Only whole lines are read. A last line without its newline is left for the next read, and the returned offset is
 * the byte after the last newline read.
 */
export type Needle = { text: string; within?: number };
export type LineSink = (text: string, lineOffset: number) => void;

const initialChunk = 4 * 1024 * 1024;
/** A single line longer than this is skipped whole: no transcript writes usage records that large. */
const maxLine = 256 * 1024 * 1024;
const newline = 0x0a;

export type ReadResult = { offset: number; bytes: number };

export async function readAppended(path: string, start: number, needles: Needle[], sink: LineSink, options: { end?: number } = {}): Promise<ReadResult> {
  const patterns = needles.map(needle => ({ bytes: Buffer.from(needle.text), within: needle.within }));
  const lineMode = patterns.every(pattern => pattern.within !== undefined);
  const head = Math.max(0, ...patterns.map(pattern => (pattern.within ?? 0) + pattern.bytes.length));
  let handle: FileHandle;
  try { handle = await open(path, "r"); }
  catch { return { offset: start, bytes: 0 }; }
  let buffer = Buffer.allocUnsafe(initialChunk);
  let filled = 0;
  /** File position of buffer[0]. */
  let base = start;
  let read = 0;
  let skipping = false;
  try {
    for (;;) {
      if (options.end !== undefined && base + filled >= options.end) break;
      const want = options.end === undefined ? buffer.length - filled : Math.min(buffer.length - filled, options.end - base - filled);
      const { bytesRead } = await handle.read(buffer, filled, want, base + filled);
      if (bytesRead === 0) break;
      read += bytesRead;
      filled += bytesRead;
      const last = buffer.lastIndexOf(newline, filled - 1);
      if (last < 0) {
        if (filled < buffer.length) continue;
        if (buffer.length >= maxLine) { skipping = true; base += filled; filled = 0; continue; }
        const bigger = Buffer.allocUnsafe(buffer.length * 2);
        buffer.copy(bigger, 0, 0, filled);
        buffer = bigger;
        continue;
      }
      let from = 0;
      if (skipping) { from = buffer.indexOf(newline, 0) + 1; skipping = false; }
      // Only the bytes read: indexOf on the whole buffer would also search the stale rest of it, about 4 MB per file.
      const view = buffer.subarray(0, last + 1);
      if (lineMode) scanLines(view, from, last, patterns, head, base, sink);
      else scanAnywhere(view, from, last, patterns, base, sink);
      const rest = filled - (last + 1);
      buffer.copy(buffer, 0, last + 1, filled);
      base += last + 1;
      filled = rest;
    }
  } finally { await handle.close(); }
  return { offset: base, bytes: read };
}

function scanLines(buffer: Buffer, from: number, last: number, patterns: { bytes: Buffer; within: number | undefined }[], head: number, base: number, sink: LineSink): void {
  let start = from;
  while (start <= last) {
    const end = buffer.indexOf(newline, start);
    const stop = end < 0 || end > last ? last : end;
    const window = buffer.subarray(start, Math.min(stop, start + head));
    for (const pattern of patterns) {
      const at = window.indexOf(pattern.bytes);
      if (at >= 0 && at <= (pattern.within ?? 0)) { sink(buffer.toString("utf8", start, stop), base + start); break; }
    }
    start = stop + 1;
  }
}

function scanAnywhere(buffer: Buffer, from: number, last: number, patterns: { bytes: Buffer }[], base: number, sink: LineSink): void {
  const starts = new Set<number>();
  for (const pattern of patterns) {
    let at = buffer.indexOf(pattern.bytes, from);
    while (at >= 0 && at < last) {
      const lineStart = buffer.lastIndexOf(newline, at) + 1;
      const lineEnd = buffer.indexOf(newline, at);
      starts.add(Math.max(lineStart, from));
      if (lineEnd < 0 || lineEnd >= last) break;
      at = buffer.indexOf(pattern.bytes, lineEnd + 1);
    }
  }
  for (const start of [...starts].sort((a, b) => a - b)) {
    const end = buffer.indexOf(newline, start);
    sink(buffer.toString("utf8", start, end < 0 || end > last ? last : end), base + start);
  }
}

/** Hex of up to 32 bytes just before `offset`: a cheap check that the bytes already read are still the same file content. */
export async function tailSample(path: string, offset: number): Promise<string> {
  if (offset <= 0) return "";
  const length = Math.min(32, offset);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
    return buffer.toString("hex", 0, bytesRead);
  } finally { await handle.close(); }
}
