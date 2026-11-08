// Runs box.mjs twice in a row against a local server and checks that the second runner takes /_app/immutable/ from the disk
// cache while the HTML page goes to the network both times. Run with: node --test --test-force-exit --test-isolation=none
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const BOX = new URL("./box.mjs", import.meta.url).pathname;

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
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "box-immutable-test-"));
  try {
    const env = { ...process.env, BOX_IMMUTABLE_CACHE: cache };
    const code = `await openTab("http://127.0.0.1:${server.address().port}/"); console.log(await page.evaluate(() => window.ran))`;
    assert.equal(await runOnce(env, code), "1");
    assert.equal(await runOnce(env, code), "1");
    assert.deepEqual(hits, { page: 2, immutable: 1 });
  } finally {
    server.close();
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
