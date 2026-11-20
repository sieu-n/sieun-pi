// Checks owner rule c230 in the box Chrome: a runner whose Chrome resolves every host to a local server (so no request leaves
// this host) refuses a platform page on goto, after a redirect and as a subresource, and still loads a normal page; then the
// runner's Node side refuses platform hosts in fetch, a fetch redirect and http.get.
// Run with: node --test --test-force-exit --test-isolation=none skills/aside-browser/box/platforms.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const BOX = new URL("./box.mjs", import.meta.url).pathname;
const hits = [];
let server, port, tmp, box;

const PAGES = {
  "/": () => [200, {}, "<!doctype html><title>normal</title>"],
  "/redirect": () => [302, { location: "http://www.tiktok.com/landing" }, ""],
  "/to-instagram": () => [302, { location: "http://www.instagram.com/" }, ""],
  "/embed": () => [200, {}, '<!doctype html><title>embed</title><img src="http://i.ytimg.com/vi/a.jpg"><script src="http://abs.twimg.com/s.js"></script><iframe src="http://www.youtube.com/embed/x"></iframe>'],
};

/** A Chrome wrapper that keeps the runner's own --host-resolver-rules first and then maps every other host to the local server. */
function wrapper() {
  const real = process.env.BOX_CHROME || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : chromium.executablePath());
  const file = path.join(tmp, "chrome");
  fs.writeFileSync(file, `#!/usr/bin/env python3
import os, sys
flag = "--host-resolver-rules="
rules = [a[len(flag):] for a in sys.argv[1:] if a.startswith(flag)] + ["MAP * 127.0.0.1:${port}"]
os.execv(${JSON.stringify(real)}, [${JSON.stringify(real)}, *[a for a in sys.argv[1:] if not a.startswith(flag)], flag + ", ".join(rules)])
`, { mode: 0o755 });
  return file;
}

function startBox(env) {
  const proc = spawn(process.execPath, [BOX], { env, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  let next = 0;
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  return {
    run: (code) => new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      proc.stdin.write(JSON.stringify({ id, code }) + "\n");
    }),
    stop: () => new Promise((resolve) => { proc.once("exit", resolve); proc.stdin.end(); }),
  };
}

const PLATFORMS = JSON.parse(fs.readFileSync(new URL("./platform-hosts.json", import.meta.url), "utf8"));
const platformHits = () => hits.filter((h) => PLATFORMS.some((p) => new RegExp(`(^|\\.)${p.replace(/\./g, "\\.")}(:|/)`).test(h)));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "box-c230-test-"));
  server = http.createServer((req, res) => {
    hits.push(`${req.headers.host}${req.url}`);
    const host = String(req.headers.host).split(":")[0];
    const [status, headers, body] = host === "normal.test" || host === "127.0.0.1" ? (PAGES[req.url] ?? (() => [404, {}, ""]))() : [200, {}, "<title>platform</title>"];
    res.writeHead(status, { "content-type": "text/html", ...headers });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  box = startBox({ ...process.env, BOX_CHROME: wrapper(), BOX_HTTP_CACHE: path.join(tmp, "cache") });
});

after(async () => {
  await box?.stop();
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("chrome: a normal page loads", async () => {
  const msg = await box.run(`await openTab("http://normal.test/"); console.log(await page.title())`);
  assert.equal(msg.error, undefined);
  assert.equal(msg.out, "normal");
});

test("chrome: openTab and page.goto of a platform URL are refused under c230", async () => {
  const direct = await box.run(`await openTab("http://www.instagram.com/")`);
  assert.match(String(direct.error), /c230/);
  const goto = await box.run(`await openTab("http://normal.test/"); await page.goto("http://instagram.com/reels/")`);
  assert.match(String(goto.error), /c230/);
  assert.deepEqual(platformHits(), []);
});

test("chrome: a redirect that lands on a platform host is refused under c230", async () => {
  const msg = await box.run(`await openTab("http://normal.test/redirect")`);
  assert.match(String(msg.error), /c230/);
  assert.match(String(msg.error), /refused http:\/\/www\.tiktok\.com\/landing/);
  assert.deepEqual(platformHits(), []);
});

test("chrome: platform subresources and frames never load, and the page does", async () => {
  const msg = await box.run(`await openTab("http://normal.test/embed"); await sleep(500); console.log(await page.title(), await page.evaluate(() => document.images[0].naturalWidth))`);
  assert.equal(msg.error, undefined);
  assert.equal(msg.out, "embed 0");
  assert.ok(hits.includes("normal.test/embed"));
  assert.deepEqual(platformHits(), []);
});

test("node: the runner's fetch, page.request and a fetch redirect refuse platform hosts", async () => {
  const msg = await box.run(`
    for (const go of [() => fetch("http://www.instagram.com/"), () => fetch("http://127.0.0.1:${port}/to-instagram"), () => page.request.get("http://www.youtube.com/")])
      console.log(await go().then(() => "went", (e) => String(e.message).includes("c230") ? "refused" : String(e)));`);
  assert.equal(msg.error, undefined);
  assert.equal(msg.out, "refused\nrefused\nrefused");
  assert.deepEqual(platformHits(), []);
});

test("node: http.get of a platform host is refused before DNS", async () => {
  const { refuseInNode } = await import("./platforms.mjs");
  refuseInNode();
  const err = await new Promise((resolve) => http.get("http://m.tiktok.com/", () => resolve(null)).on("error", resolve));
  assert.match(String(err?.message), /c230/);
});
