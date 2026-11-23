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
/**
 * A kept answer (`KeptJson`) is compressed once per version off the event loop, mostly before any read (`warmKeptJson`), so it gets
 * quality 9: the lean skills view of 11-23 was 75.7 KB in 66 to 98 ms, against 99.4 KB at quality 4 and 82.5 KB at 6.
 */
const KEPT_QUALITY = 9;

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

/** One entry of a listed answer's list: its id, its JSON text and a hash of that text. */
export type ListedEntry = { id: string; json: string; hash: string };

/** The entries of a list whose rows carry an `id`, for a `Listed` answer. */
export function listedEntries(rows: readonly { id: string }[]): ListedEntry[] {
  return rows.map(row => {
    const json = JSON.stringify(row);
    return { id: row.id, json, hash: createHash("sha1").update(json).digest("base64url") };
  });
}

/**
 * A big JSON answer whose bulk is one list of rows by id: `json` is the whole answer, `rest` the answer without the list, which the page
 * puts back where its read says (web/src/lib/api/shared/listed.ts).
 */
export type Listed = { json: string; rest: string; entries: readonly ListedEntry[] };

/**
 * A big JSON answer that changes only when its parts do, such as GET /api/skills, 3.4 MB as JSON for 609 skills on 11-23 and 226 KB as
 * brotli. `parts` say when it changed: each is compared with `===`, so an object part counts as unchanged while the server keeps the same
 * object, and `make` makes the answer only after a part changed. `since` is the `?since=` of a read that asks for the changes since the
 * version it holds (`sendKeptJson`), and null for a plain read.
 */
export class KeptJson {
  constructor(readonly name: string, readonly parts: readonly unknown[], readonly make: () => Listed, readonly since: string | null = null) {}
}

type Made = { parts: readonly unknown[]; listed: Listed; tag: string; order: string; full: string | null; bytes: Map<string, Promise<Buffer>> };
const made = new Map<string, Made>();
/** A version a page may hold: each entry's hash by id, and the ids in order. */
type Version = { tag: string; hashes: Map<string, string>; order: string };
/**
 * Each answer's newest versions, for the changes since one of them. A version of the 609 skills is about 60 KB, and a page that holds an
 * older one than these gets the whole list, as a first read does. The server took 2 scans an hour on 11-23 (the hourly one and the
 * owner's or a walk's), and since http.ts makes each answer ahead, a scan makes 3 versions of the view (its start, its ingest and its
 * end), so 96 versions reach back about half a day.
 */
const VERSIONS = 96;
const versions = new Map<string, Version[]>();

function current(answer: KeptJson): Made {
  const entry = made.get(answer.name);
  if (entry && entry.parts.length === answer.parts.length && entry.parts.every((part, i) => part === answer.parts[i])) return entry;
  const listed = answer.make();
  const tag = createHash("sha1").update(listed.rest).update(listed.entries.map(e => e.hash).join(",")).digest("base64url");
  const order = listed.entries.map(e => e.id).join("\n");
  const next: Made = { parts: answer.parts, listed, tag, order, full: null, bytes: new Map() };
  made.set(answer.name, next);
  const kept = versions.get(answer.name) ?? [];
  if (kept.at(-1)?.tag !== tag) kept.push({ tag, hashes: new Map(listed.entries.map(e => [e.id, e.hash])), order });
  versions.set(answer.name, kept.slice(-VERSIONS));
  return next;
}

/** The kept bytes of `text` in `encoding`, compressed once per version at KEPT_QUALITY off the event loop. */
function keptBytes(entry: Made, key: string, encoding: Encoding, text: () => string): Promise<Buffer> {
  let bytes = entry.bytes.get(`${key}:${encoding}`);
  if (!bytes) {
    const plain = Buffer.from(text());
    bytes = encoding === "br" ? brotliAsync(plain, brotliOptions(KEPT_QUALITY, plain.length)) : gzipAsync(plain);
    entry.bytes.set(`${key}:${encoding}`, bytes);
    bytes.catch(() => entry.bytes.delete(`${key}:${encoding}`));
  }
  return bytes;
}

/**
 * The changes since the version `since` names, as web/src/lib/api/shared/listed.ts `ListedAnswer` reads them: `same` when the page holds
 * this version, the rest and the entries that differ from that version when the server still knows it, else the whole list.
 */
function changesSince(name: string, entry: Made, since: string): { text: string; full: boolean } {
  if (since === entry.tag) return { text: JSON.stringify({ tag: entry.tag, same: true }), full: false };
  const old = versions.get(name)?.find(version => version.tag === since);
  const { rest, entries } = entry.listed;
  if (!old) return { text: (entry.full ??= `{"tag":${JSON.stringify(entry.tag)},"full":true,"rest":${rest},"entries":[${entries.map(e => e.json).join(",")}]}`), full: true };
  const ids = new Set(entries.map(e => e.id));
  const changed = entries.filter(e => old.hashes.get(e.id) !== e.hash).map(e => e.json);
  const removed = [...old.hashes.keys()].filter(id => !ids.has(id));
  const order = old.order === entry.order ? "" : `,"order":${JSON.stringify([...ids])}`;
  return { text: `{"tag":${JSON.stringify(entry.tag)},"rest":${rest},"entries":[${changed.join(",")}],"removed":${JSON.stringify(removed)}${order}}`, full: false };
}

/**
 * Makes the whole `?since=` answer of `answer` and its bytes in `encoding` before any read asks for them, as a page with nothing kept
 * reads it. On 11-23 the first such read after each release or scan ran 442 to 797 ms on the server (requests/2026-11-23.jsonl, via
 * tailnet), building the view and compressing it, while every later one ran in under 2 ms.
 */
export async function warmKeptJson(answer: KeptJson, encoding: Encoding): Promise<void> {
  const entry = current(answer);
  const { text, full } = changesSince(answer.name, entry, "");
  if (full && text.length >= MIN_BYTES) await keptBytes(entry, "full", encoding, () => text);
}

/**
 * Sends a `KeptJson`. A plain read gets the bytes made at its first request since its parts changed, with an ETag and `no-cache`, so a
 * browser that keeps it asks again with If-None-Match and gets 304 with no body. A read with `?since=` gets only what changed since the
 * version it holds. Each GET /api/skills used to stringify and brotli the whole view again, 35 to 50 ms of the event loop on us-metal02
 * (p50 85 ms, p90 246 ms in requests/2026-11-2*.jsonl), and sent its 252 KB again on every open of the Skills page. After a scan the
 * page's refresh of the view still took 1,189 ms in the p155 rig (full2-1119bea), since a scan changed 35 of 609 skills and the whole
 * view came down again (~/work/p155-sweep/fix-skills/notes.md).
 */
export async function sendKeptJson(res: ServerResponse, headers: OutgoingHttpHeaders, answer: KeptJson): Promise<void> {
  const entry = current(answer);
  if (answer.since !== null) {
    const { text, full } = changesSince(answer.name, entry, answer.since);
    const plain = { ...headers, "cache-control": "no-store" };
    const encoding = full && text.length >= MIN_BYTES ? encodingFor(res.req) : undefined;
    if (!encoding) return sendCompressed(res, 200, plain, text);
    const out = await keptBytes(entry, "full", encoding, () => text);
    res.writeHead(200, { ...plain, vary: "accept-encoding", "content-length": out.length, "content-encoding": encoding });
    res.end(out);
    return;
  }
  const json = entry.listed.json;
  const encoding = json.length < MIN_BYTES ? undefined : encodingFor(res.req);
  const etag = `"${entry.tag}${encoding ? `-${encoding}` : ""}"`;
  const cached = { ...headers, "cache-control": "no-cache", vary: "accept-encoding", etag };
  const asked = res.req?.headers["if-none-match"];
  if (asked && asked.split(",").some(tag => tag.trim().replace(/^W\//, "") === etag)) {
    res.writeHead(304, cached);
    res.end();
    return;
  }
  if (!encoding) {
    const bytes = Buffer.from(json);
    res.writeHead(200, { ...cached, "content-length": bytes.length });
    res.end(bytes);
    return;
  }
  const out = await keptBytes(entry, "plain", encoding, () => json);
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
