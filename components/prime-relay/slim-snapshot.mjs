import { Transform } from "node:stream";

/** The upgrade header a client sets on `GET /v1/daemon` to get attach snapshots without the image data of their older messages (`slimSnapshots`). */
export const SLIM_HEADER = "x-prime-slim-snapshot";
const PREFIX = Buffer.from('{"type":"session_snapshot_chunk"');
const NEWLINE = 10;

/** A snapshot chunk line with the base64 data of every image in its messages emptied; the image part stays with its mime type. A line that does not parse goes as it came. */
export function stripImages(line) {
  let chunk;
  try { chunk = JSON.parse(line.toString("utf8")); } catch { return line; }
  for (const message of chunk.messages ?? []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === "image" && typeof part.data === "string") part.data = "";
      if (Array.isArray(part?.content)) for (const inner of part.content) if (inner?.type === "image" && typeof inner.data === "string") inner.data = "";
    }
  }
  return Buffer.from(JSON.stringify(chunk) + "\n");
}

/**
 * The daemon-to-client byte stream with each attach snapshot's chunks but the last sent without image data. The daemon streams the whole context
 * since the last compaction on every attach, and a box that reads the session's older messages from its own copy of the file needs only the newest
 * ones whole: on 10-18 frontend bro's snapshot was 9.9 MB, 7.75 MB of it screenshots, over a link from the Mac that gave 0.26 to 1.4 MB/s. A chunk
 * waits for the next line of its snapshot to know whether it is the last; every other line passes through as it arrives.
 */
export function slimSnapshots() {
  const held = new Map();
  let mode = "start";
  let pending = [];
  let pendingBytes = 0;
  const release = (stream, snapshotId, strip) => {
    const line = held.get(snapshotId);
    if (!line) return;
    held.delete(snapshotId);
    stream.push(strip ? stripImages(line) : line);
  };
  const finishLine = (stream, line) => {
    if (line.subarray(0, PREFIX.length).equals(PREFIX)) {
      const id = /"snapshotId":"([^"]*)"/.exec(line.subarray(0, 512).toString("utf8"))?.[1] ?? "";
      release(stream, id, true);
      held.set(id, line);
      return;
    }
    const head = line.subarray(0, 512).toString("utf8");
    if (/^\{"type":"session_snapshot_(end|failed)"/.test(head)) release(stream, /"snapshotId":"([^"]*)"/.exec(head)?.[1] ?? "", false);
    stream.push(line);
  };
  return new Transform({
    transform(data, _encoding, done) {
      let at = 0;
      while (at < data.length) {
        if (mode === "pass") {
          const end = data.indexOf(NEWLINE, at);
          if (end < 0) { this.push(data.subarray(at)); return done(); }
          this.push(data.subarray(at, end + 1));
          at = end + 1;
          mode = "start";
          continue;
        }
        const end = data.indexOf(NEWLINE, at);
        const piece = data.subarray(at, end < 0 ? data.length : end + 1);
        pending.push(piece);
        pendingBytes += piece.length;
        at += piece.length;
        if (end >= 0) {
          const line = Buffer.concat(pending, pendingBytes);
          pending = []; pendingBytes = 0; mode = "start";
          finishLine(this, line);
          continue;
        }
        if (mode === "start" && pendingBytes >= PREFIX.length) {
          const start = Buffer.concat(pending, pendingBytes);
          if (start.subarray(0, PREFIX.length).equals(PREFIX) || /^\{"type":"session_snapshot_(end|failed)"/.test(start.toString("utf8"))) { mode = "chunk"; pending = [start]; }
          else { this.push(start); pending = []; pendingBytes = 0; mode = "pass"; }
        }
      }
      done();
    },
    flush(done) {
      for (const id of [...held.keys()]) release(this, id, false);
      if (pendingBytes) this.push(Buffer.concat(pending, pendingBytes));
      done();
    },
  });
}
