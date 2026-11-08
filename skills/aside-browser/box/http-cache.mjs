// One on-disk HTTP cache per host, shared by every box runner, for the few URLs whose repeat fetches Vercel bills. Each runner
// starts Chrome in a fresh off-the-record context, and aside_browser stops it at every turn end, so each walk began with an
// empty HTTP cache. On 11-07 box Chromes on us-metal02 fetched staging.virev.ai's immutable files 3,550 times in one hour
// from 23:00Z, and asked its /api/img 16,720 times for 8,121 URLs that day, each a billed Vercel function call. A walk of
// 3 staging domain pages on 11-08 also asked /api/logo 28 times, each a CDN MISS and so a function call too. Every other
// URL stays with Chrome. Every box Chrome on a host is ours, so one cache keyed by URL may keep a `private` answer too.
// The cache hooks in through CDP Fetch on each page, not context.route(), because Playwright turns off a context's HTTP
// cache once it routes, and Fetch runs in Chrome's own network stack, so the loopback proxy and cookies apply to a miss.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CACHE_DIR = process.env.BOX_HTTP_CACHE || path.join(os.homedir(), ".cache", "aside-box", "http");

// The seconds a whole 200 answer stays: its own max-age, and none for no-store or no-cache, as auto-sns-agent's
// tests/e2e/helpers/clerk-vent.ts reuseSeconds keeps answers for staging-proof.
const maxAge = (headers) => {
  const cc = headers.find((h) => h.name.toLowerCase() === "cache-control")?.value ?? "";
  if (/\bno-(?:store|cache)\b/i.test(cc)) return 0;
  return Number(/\bmax-age=(\d+)/i.exec(cc)?.[1] ?? 0);
};
// Each deploy brings new content hashes, so a week bounds the files of old builds; on 11-07 a walk of 4 staging pages
// stored 62 of them, 3.9 MB, and a file still in use costs one more fetch a week.
const WEEK_S = 7 * 24 * 3600;
// urlPattern is CDP Fetch's glob, so Chrome pauses only these URLs, and keep() gives a 200's seconds in the cache.
export const RULES = [
  { urlPattern: "*/_app/immutable/*", keep: () => WEEK_S },
  { urlPattern: "https://staging.virev.ai/api/img*", keep: maxAge },
  { urlPattern: "https://staging.virev.ai/api/logo/*", keep: maxAge },
].map((rule) => ({ ...rule, re: new RegExp(`^${rule.urlPattern.split("*").map((s) => s.replace(/[.?+^$()[\]{}|\\/]/g, "\\$&")).join(".*")}$`) }));
const ruleFor = (url) => RULES.find((rule) => rule.re.test(url));

// The stored body is decoded, so these headers would describe bytes the cache does not hold.
const DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]);

const fileFor = (url) => path.join(CACHE_DIR, createHash("sha256").update(url).digest("hex"));

// A file holds one JSON line with the headers and the time it expires (`until`, ms), then the body. It is written to a
// temp name and renamed, so a runner reading it never sees half a file.
function readMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(65536);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const end = head.subarray(0, n).indexOf(10);
    return end < 0 ? null : { ...JSON.parse(head.subarray(0, end).toString()), start: end + 1 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** A runner start removes every file whose answer has expired or cannot be read. */
export function pruneShared(now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(CACHE_DIR); } catch { return; }
  for (const name of names) {
    const file = path.join(CACHE_DIR, name);
    if (!(readMeta(file)?.until > now)) fs.rmSync(file, { force: true });
  }
}

function read(url, now = Date.now()) {
  const file = fileFor(url);
  const meta = readMeta(file);
  if (!(meta?.until > now)) return null;
  try { return { headers: meta.headers, body: fs.readFileSync(file).subarray(meta.start) }; } catch { return null; }
}

function write(url, headers, until, body) {
  const file = fileFor(url);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(tmp, Buffer.concat([Buffer.from(JSON.stringify({ headers, until }) + "\n"), body]));
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

/** Serves the page's whole GETs of RULES' URLs from CACHE_DIR, and stores each 200 from the network that a rule keeps. */
export async function cacheShared(context, page) {
  const cdp = await context.newCDPSession(page);
  const send = (method, params) => cdp.send(method, params).catch(() => {});
  cdp.on("Fetch.requestPaused", async ({ requestId, request, responseStatusCode, responseHeaders }) => {
    const whole = request.method === "GET" && !Object.keys(request.headers ?? {}).some((h) => h.toLowerCase() === "range");
    if (responseStatusCode === undefined) {
      const hit = whole ? read(request.url) : null;
      if (hit) return send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: hit.headers, body: hit.body.toString("base64") });
      return send("Fetch.continueRequest", { requestId, interceptResponse: whole });
    }
    const seconds = responseStatusCode === 200 ? ruleFor(request.url)?.keep(responseHeaders) ?? 0 : 0;
    if (seconds > 0) {
      const got = await cdp.send("Fetch.getResponseBody", { requestId }).catch(() => null);
      if (got) write(request.url, responseHeaders.filter((h) => !DROP.has(h.name.toLowerCase())), Date.now() + seconds * 1000, Buffer.from(got.body, got.base64Encoded ? "base64" : "utf8"));
    }
    return send("Fetch.continueRequest", { requestId });
  });
  await send("Fetch.enable", { patterns: RULES.map(({ urlPattern }) => ({ urlPattern, requestStage: "Request" })) });
}
