// Runs box.mjs twice in a row against a local server and checks that the second runner takes /_app/immutable/ from the disk
// cache while the HTML page goes to the network both times, then drives http-cache.mjs with a fake Chrome for the
// staging.virev.ai /api/img rules. Run with: node --test --test-force-exit --test-isolation=none
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const BOX = new URL("./box.mjs", import.meta.url).pathname;
const CACHE = new URL("./http-cache.mjs", import.meta.url).href;

async function runOnce(env, code) {
  const proc = spawn(process.execPath, [BOX], { env, stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  proc.stdin.write(JSON.stringify({ id: 1, code }) + "\n");
  const line = await Promise.race([
    new Promise((resolve) => createInterface({ input: proc.stdout }).once("line", resolve)),
    exited.then((c) => { throw new Error(`box.mjs exited ${c} before answering`); }),
  ]);
  proc.stdin.end();
  await exited;
  const msg = JSON.parse(line);
  if (msg.error) throw new Error(msg.error);
  return msg.out;
}

test("a second runner serves /_app/immutable/ from disk and still fetches the page", async () => {
  const hits = { page: 0, immutable: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === "/_app/immutable/entry/x.js") {
      hits.immutable++;
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=31536000, immutable" });
      return res.end("window.ran = (window.ran || 0) + 1;");
    }
    if (req.url !== "/") { res.writeHead(404); return res.end(); }
    hits.page++;
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache" });
    res.end('<!doctype html><title>t</title><script src="/_app/immutable/entry/x.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "box-http-cache-test-"));
  try {
    const env = { ...process.env, BOX_HTTP_CACHE: cache };
    const code = `await openTab("http://127.0.0.1:${server.address().port}/"); console.log(await page.evaluate(() => window.ran))`;
    assert.equal(await runOnce(env, code), "1");
    assert.equal(await runOnce(env, code), "1");
    assert.deepEqual(hits, { page: 2, immutable: 1 });
  } finally {
    server.close();
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

// A Chrome that pauses a request only when an enabled Fetch pattern matches its URL, as CDP does, and counts what reaches
// the server. Each fakeTab() is a new page in a new runner, so only the disk cache carries over.
function fakeChrome(server) {
  const reached = [];
  async function fakeTab(cacheShared) {
    const handlers = [];
    let patterns = [];
    const waiting = new Map();
    const cdp = {
      on: (event, fn) => event === "Fetch.requestPaused" && handlers.push(fn),
      async send(method, params) {
        if (method === "Fetch.enable") patterns = params.patterns.map((p) => new RegExp(`^${p.urlPattern.split("*").map((s) => s.replace(/[.?+^$()[\]{}|\\/]/g, "\\$&")).join(".*")}$`));
        else if (method === "Fetch.getResponseBody") return { body: waiting.get(params.requestId).answer.body.toString("base64"), base64Encoded: true };
        else waiting.get(params.requestId).resolve({ method, params });
        return {};
      },
    };
    await cacheShared({ newCDPSession: async () => cdp });
    let ids = 0;
    const pause = (event, entry) => new Promise((resolve) => {
      waiting.set(event.requestId, { ...entry, resolve });
      for (const fn of handlers) fn(event);
    });
    async function load(url, headers = {}) {
      const toServer = () => { reached.push(url); return server(url, headers); };
      if (!patterns.some((re) => re.test(url))) return toServer().status;
      const request = { url, method: "GET", headers };
      const first = await pause({ requestId: `r${++ids}`, request }, {});
      if (first.method === "Fetch.fulfillRequest") {
        load.last = first.params.responseHeaders;
        return first.params.responseCode;
      }
      const answer = toServer();
      if (!first.params.interceptResponse) return answer.status;
      const requestId = `r${++ids}`;
      const headerList = Object.entries(answer.headers).map(([name, value]) => ({ name, value }));
      await pause({ requestId, request, responseStatusCode: answer.status, responseHeaders: headerList }, { answer });
      return answer.status;
    }
    return load;
  }
  return { reached, fakeTab };
}

test("whole 200 answers of staging /api/img and /api/logo come from disk for their max-age, and ranges, no-store and errors do not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-http-cache-test-"));
  process.env.BOX_HTTP_CACHE = dir;
  try {
    const { cacheShared, pruneShared } = await import(`${CACHE}?t=${Date.now()}`);
    const img = "https://staging.virev.ai/api/img?u=a";
    const answers = {
      [img]: { status: 200, headers: { "cache-control": "private, max-age=86400, stale-while-revalidate=86400", "content-type": "image/webp" } },
      "https://staging.virev.ai/api/img?u=short": { status: 200, headers: { "cache-control": "private, max-age=1" } },
      "https://staging.virev.ai/api/img?u=nostore": { status: 200, headers: { "cache-control": "no-store" } },
      "https://staging.virev.ai/api/img?u=missing": { status: 404, headers: { "cache-control": "private, max-age=86400" } },
      "https://staging.virev.ai/api/img?u=video": { status: 200, headers: { "cache-control": "private, max-age=300" } },
      "https://staging.virev.ai/api/logo/glossier.com": { status: 200, headers: { "cache-control": "public, max-age=86400", "content-type": "image/png" } },
      "https://staging.virev.ai/api/logo/nostore.com": { status: 200, headers: { "cache-control": "no-store" } },
      "https://staging.virev.ai/api/me": { status: 200, headers: { "cache-control": "private, max-age=86400" } },
    };
    const { reached, fakeTab } = fakeChrome((url) => ({ ...answers[url], body: Buffer.from(`bytes of ${url}`) }));
    const walk = async () => {
      const load = await fakeTab(cacheShared);
      for (const url of Object.keys(answers)) await load(url);
      await load("https://staging.virev.ai/api/img?u=video", { Range: "bytes=0-99" });
    };
    await walk();
    assert.equal(reached.length, 9);
    await walk();
    assert.deepEqual(reached.slice(9), [
      "https://staging.virev.ai/api/img?u=nostore",
      "https://staging.virev.ai/api/img?u=missing",
      "https://staging.virev.ai/api/logo/nostore.com",
      "https://staging.virev.ai/api/me",
      "https://staging.virev.ai/api/img?u=video",
    ]);
    pruneShared(Date.now() + 2000);
    const load = await fakeTab(cacheShared);
    assert.equal(await load("https://staging.virev.ai/api/img?u=short"), 200);
    assert.equal(await load(img), 200);
    assert.deepEqual(reached.slice(14), ["https://staging.virev.ai/api/img?u=short"]);
  } finally {
    delete process.env.BOX_HTTP_CACHE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ASIDE_BOX_IMAGES=0 answers crawler pictures with a 204 and no body, so none reaches the server, and every other URL still does", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-http-cache-test-"));
  process.env.BOX_HTTP_CACHE = dir;
  process.env.ASIDE_BOX_IMAGES = "0";
  try {
    const { cacheShared } = await import(`${CACHE}?t=${Date.now()}`);
    const pictures = [
      "https://staging.virev.ai/api/img?u=a",
      "https://virev.ai/api/img?u=a",
      "http://localhost:5174/api/img?u=a",
      "http://127.0.0.1:5174/api/img?u=a",
    ];
    const others = ["https://staging.virev.ai/api/logo/glossier.com", "https://staging.virev.ai/api/me", "http://localhost:5174/app/search"];
    const { reached, fakeTab } = fakeChrome(() => ({ status: 200, headers: { "cache-control": "no-store" }, body: Buffer.from("x") }));
    const load = await fakeTab(cacheShared);
    for (const url of pictures) assert.equal(await load(url), 204, url);
    for (const url of others) assert.equal(await load(url), 200, url);
    assert.deepEqual(reached, others);
  } finally {
    delete process.env.BOX_HTTP_CACHE;
    delete process.env.ASIDE_BOX_IMAGES;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a busy /api/img answer comes from disk until its Retry-After ends, with the seconds left, and then goes to the server again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-http-cache-test-"));
  process.env.BOX_HTTP_CACHE = dir;
  try {
    const { cacheShared, pruneShared } = await import(`${CACHE}?t=${Date.now()}`);
    const busy = "https://staging.virev.ai/api/img?u=busy";
    const answers = {
      [busy]: { status: 202, headers: { "cache-control": "no-store", "retry-after": "30" } },
      "https://staging.virev.ai/api/img?u=noretry": { status: 202, headers: { "cache-control": "no-store" } },
      "https://staging.virev.ai/api/logo/busy.com": { status: 202, headers: { "cache-control": "no-store", "retry-after": "30" } },
      "https://staging.virev.ai/api/img?u=gone": { status: 204, headers: { "cache-control": "no-store", "retry-after": "30" } },
    };
    const { reached, fakeTab } = fakeChrome((url) => ({ ...answers[url], body: Buffer.alloc(0) }));
    const first = await fakeTab(cacheShared);
    for (const url of Object.keys(answers)) await first(url);
    const again = await fakeTab(cacheShared);
    for (const url of Object.keys(answers)) assert.equal(await again(url), answers[url].status, url);
    assert.deepEqual(reached.filter((u) => u === busy), [busy]);
    assert.equal(reached.length, 7);
    await again(busy);
    const left = Number(again.last.find((h) => h.name === "retry-after").value);
    assert.ok(left > 0 && left <= 30, `Retry-After ${left}`);
    pruneShared(Date.now() + 31_000);
    assert.equal(await (await fakeTab(cacheShared))(busy), 202);
    assert.deepEqual(reached.filter((u) => u === busy), [busy, busy]);
  } finally {
    delete process.env.BOX_HTTP_CACHE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pages of a context the walk makes itself take /_app/immutable/ from disk too", async () => {
  const hits = { immutable: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === "/_app/immutable/entry/y.js") {
      hits.immutable++;
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=31536000, immutable" });
      return res.end("window.ran = (window.ran || 0) + 1;");
    }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache" });
    res.end('<!doctype html><title>t</title><script src="/_app/immutable/entry/y.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "box-http-cache-test-"));
  try {
    const env = { ...process.env, BOX_HTTP_CACHE: cache };
    const url = `http://127.0.0.1:${server.address().port}/`;
    const code = `const ctx = await page.context().browser().newContext(); const p = await ctx.newPage(); await p.goto(${JSON.stringify(url)});`
      + ` const q = await (await page.context().browser().newContext()).newPage(); await q.goto(${JSON.stringify(url)});`
      + " console.log(await p.evaluate(() => window.ran) + await q.evaluate(() => window.ran))";
    assert.equal(await runOnce(env, `await openTab("about:blank"); ${code}`), "2");
    assert.equal(hits.immutable, 1);
  } finally {
    server.close();
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
