// One on-disk cache per host for SvelteKit's content-hashed /_app/immutable/ files, shared by every box runner. Each runner
// starts Chrome in a fresh off-the-record context, and aside_browser stops it at every turn end, so each walk began with an
// empty HTTP cache. On 11-07 from 23:00Z box Chromes on us-metal02 fetched staging.virev.ai's immutable files 3,550 times
// in one hour on 379 URLs, and each fetch is a billed Vercel CDN request. Pages, APIs and every other URL stay uncached.
// The cache hooks in through CDP Fetch on each page, not context.route(), because Playwright turns off a context's HTTP
// cache once it routes, and Fetch runs in Chrome's own network stack, so the loopback proxy and cookies apply to a miss.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CACHE_DIR = process.env.BOX_IMMUTABLE_CACHE || path.join(os.homedir(), ".cache", "aside-box", "immutable");
const PATTERN = "*/_app/immutable/*";
// The stored body is decoded, so these headers would describe bytes the cache does not hold.
const DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]);

// Each deploy brings new hashes, so files of old builds pile up; on 11-07 a walk of 4 staging pages stored 62 files, 3.9 MB.
// A runner start removes files written over a week ago, and a file still in use costs one more fetch a week.
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export function pruneImmutable(now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(CACHE_DIR); } catch { return; }
  for (const name of names) {
    const file = path.join(CACHE_DIR, name);
    try { if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.rmSync(file, { force: true }); } catch {}
  }
}

const fileFor = (url) => path.join(CACHE_DIR, createHash("sha256").update(url).digest("hex"));

// A file holds one JSON line with the status and headers, then the body. It is written to a temp name and renamed, so a
// runner reading it never sees half a file.
function read(url) {
  let buf;
  try { buf = fs.readFileSync(fileFor(url)); } catch { return null; }
  const end = buf.indexOf(10);
  if (end < 0) return null;
  try { return { ...JSON.parse(buf.subarray(0, end).toString()), body: buf.subarray(end + 1) }; } catch { return null; }
}

function write(url, headers, body) {
  const file = fileFor(url);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(tmp, Buffer.concat([Buffer.from(JSON.stringify({ headers }) + "\n"), body]));
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

/** Serves the page's GETs of /_app/immutable/ from CACHE_DIR, and stores each 200 that reaches the network. */
export async function cacheImmutable(context, page) {
  const cdp = await context.newCDPSession(page);
  const send = (method, params) => cdp.send(method, params).catch(() => {});
  cdp.on("Fetch.requestPaused", async ({ requestId, request, responseStatusCode, responseHeaders }) => {
    if (responseStatusCode === undefined) {
      const hit = request.method === "GET" ? read(request.url) : null;
      if (hit) return send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: hit.headers, body: hit.body.toString("base64") });
      return send("Fetch.continueRequest", { requestId, interceptResponse: request.method === "GET" });
    }
    if (responseStatusCode === 200) {
      const got = await cdp.send("Fetch.getResponseBody", { requestId }).catch(() => null);
      if (got) write(request.url, responseHeaders.filter((h) => !DROP.has(h.name.toLowerCase())), Buffer.from(got.body, got.base64Encoded ? "base64" : "utf8"));
    }
    return send("Fetch.continueRequest", { requestId });
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: PATTERN, requestStage: "Request" }] });
}
