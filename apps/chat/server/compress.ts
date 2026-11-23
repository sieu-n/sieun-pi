/**
 * Compressed answers: brotli or gzip by the request's Accept-Encoding, with Vary. The owner reads :5184 from Korea at a 197 ms round trip,
 * and on 11-19 his GET /api/c/:id/items took 403 ms of network time at the median for 12.3 KB, two round trips, since the answer was
 * larger than the connection's first window. On that day /api/conversations was 291 KB as JSON and 31.6 KB as brotli, a kimchi search
 * 52.0 KB and 17.9 KB, and the client's index script 654 KB and 198 KB.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { brotliCompress, brotliCompressSync, constants, gzip, gzipSync } from "node:zlib";
import { promisify } from "node:util";

export type Encoding = "br" | "gzip";

/** A body that fits one packet gains nothing: Tailscale's MTU is 1,280 bytes, and the headers take part of it. */
export const MIN_BYTES = 1_000;

/**
 * Brotli quality 4 for an answer made per request: it took 2.4 ms for the 291 KB of /api/conversations and 0.5 ms for a 20 KB search on
 * us-metal02 on 11-19, about gzip's time for a smaller result. Quality 5 took 4.5 ms and saved 5% more.
 */
const LIVE_QUALITY = 4;
/** A file is compressed once and kept, so it gets quality 5: 22 ms for the 654 KB index script, 198 KB against 213 KB at quality 4. */
const FILE_QUALITY = 5;

const brotliOptions = (quality: number, size: number) => ({ params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: size } });
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** The encoding to answer with: brotli when the client takes it, else gzip, else none. A `q=0` refuses an encoding. */
export function encodingFor(req: IncomingMessage | undefined): Encoding | undefined {
  const header = req?.headers["accept-encoding"];
  const text = Array.isArray(header) ? header.join(",") : header ?? "";
  const taken = new Set<string>();
  for (const part of text.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(/\s*;\s*/);
    const q = params.find(p => p.startsWith("q="));
    if (name && (!q || Number(q.slice(2)) > 0)) taken.add(name);
  }
  return taken.has("br") ? "br" : taken.has("gzip") ? "gzip" : undefined;
}

/** Sends a body made for this request, compressed when the client takes an encoding and the body is over one packet. */
export function sendCompressed(res: ServerResponse, status: number, headers: OutgoingHttpHeaders, body: string | Buffer): void {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  const encoding = bytes.length < MIN_BYTES ? undefined : encodingFor(res.req);
  const out = encoding === "br" ? brotliCompressSync(bytes, brotliOptions(LIVE_QUALITY, bytes.length)) : encoding === "gzip" ? gzipSync(bytes) : bytes;
  res.writeHead(status, { ...headers, vary: "accept-encoding", "content-length": out.length, ...(encoding ? { "content-encoding": encoding } : {}) });
  res.end(out);
}

/**
 * A big JSON answer that changes only when its parts do, such as GET /api/skills, 3.4 MB as JSON for 609 skills on 11-23 and 226 KB as
 * brotli. `parts` say when it changed: each is compared with `===`, so an object part counts as unchanged while the server keeps the same
 * object, and `json` makes the answer's text only after a part changed.
 */
export class KeptJson {
  constructor(readonly name: string, readonly parts: readonly unknown[], readonly json: () => string) {}
}

type Made = { parts: readonly unknown[]; json: string; tag: string; bytes: Map<Encoding, Promise<Buffer>> };
const made = new Map<string, Made>();

/**
 * Sends a `KeptJson` from the bytes made at its first request since its parts changed, with an ETag and `no-cache`, so the browser keeps
 * it and asks again with If-None-Match, which answers 304 with no body. Each GET /api/skills used to stringify and brotli the whole view
 * again, 35 to 50 ms of the event loop on us-metal02 (p50 85 ms, p90 246 ms in requests/2026-11-2*.jsonl), and sent its 252 KB again on
 * every open of the Skills page, about five round trips of the owner's 200 ms link (~/work/p155-sweep/fix-skills/notes.md).
 */
export async function sendKeptJson(res: ServerResponse, headers: OutgoingHttpHeaders, answer: KeptJson): Promise<void> {
  let entry = made.get(answer.name);
  if (!entry || entry.parts.length !== answer.parts.length || entry.parts.some((part, i) => part !== answer.parts[i])) {
    const json = answer.json();
    entry = { parts: answer.parts, json, tag: createHash("sha1").update(json).digest("base64url"), bytes: new Map() };
    made.set(answer.name, entry);
  }
  const encoding = entry.json.length < MIN_BYTES ? undefined : encodingFor(res.req);
  const etag = `"${entry.tag}${encoding ? `-${encoding}` : ""}"`;
  const cached = { ...headers, "cache-control": "no-cache", vary: "accept-encoding", etag };
  const asked = res.req?.headers["if-none-match"];
  if (asked && asked.split(",").some(tag => tag.trim().replace(/^W\//, "") === etag)) {
    res.writeHead(304, cached);
    res.end();
    return;
  }
  if (!encoding) {
    const bytes = Buffer.from(entry.json);
    res.writeHead(200, { ...cached, "content-length": bytes.length });
    res.end(bytes);
    return;
  }
  let bytes = entry.bytes.get(encoding);
  if (!bytes) {
    const plain = Buffer.from(entry.json);
    bytes = encoding === "br" ? brotliAsync(plain, brotliOptions(FILE_QUALITY, plain.length)) : gzipAsync(plain);
    entry.bytes.set(encoding, bytes);
    const kept = entry;
    bytes.catch(() => kept.bytes.delete(encoding));
  }
  const out = await bytes;
  res.writeHead(200, { ...cached, "content-length": out.length, "content-encoding": encoding });
  res.end(out);
}

/** The types of the web client's files that compress; images and fonts are compressed already. */
const TEXT_FILE = /\.(?:html|js|css|svg|json)$/;
export const compressibleFile = (file: string): boolean => TEXT_FILE.test(file);

/** Each text file's compressed bytes by encoding, made at its first request and kept while the file's size and change time stay. */
const files = new Map<string, { stamp: string; bytes: Promise<Buffer> }>();

/** Sends a text file of the web client, compressed once per encoding; the caller checked that it is a file. */
export async function sendFileCompressed(res: ServerResponse, headers: OutgoingHttpHeaders, file: string, stat: { size: number; mtimeMs: number }): Promise<void> {
  const encoding = stat.size < MIN_BYTES ? undefined : encodingFor(res.req);
  if (!encoding) {
    const bytes = await readFile(file);
    res.writeHead(200, { ...headers, vary: "accept-encoding", "content-length": bytes.length });
    res.end(bytes);
    return;
  }
  const key = `${encoding}\u0000${file}`;
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  let kept = files.get(key);
  if (kept?.stamp !== stamp) {
    kept = { stamp, bytes: readFile(file).then(bytes => (encoding === "br" ? brotliAsync(bytes, brotliOptions(FILE_QUALITY, bytes.length)) : gzipAsync(bytes))) };
    files.set(key, kept);
    kept.bytes.catch(() => files.delete(key));
  }
  const bytes = await kept.bytes;
  res.writeHead(200, { ...headers, vary: "accept-encoding", "content-length": bytes.length, "content-encoding": encoding });
  res.end(bytes);
}
