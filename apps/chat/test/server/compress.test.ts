/**
 * A JSON answer and a text file of the web client come back as brotli or gzip when the request takes one, with Vary, and decode to the
 * same bytes as the plain answer. Before 11-19 the server sent every answer plain: /api/conversations was 291 KB on :5184, and the owner's
 * 12.3 KB timeline page took two round trips of his 197 ms link.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { start, type Running } from "./helpers.ts";

let s: Running;
let webDir: string;
const SCRIPT = `export const words = ${JSON.stringify(Array.from({ length: 400 }, (_, i) => `word ${i}`))};\n`;

before(async () => {
  s = await start();
  webDir = mkdtempSync(join(tmpdir(), "apps-chat-web-"));
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "index.html"), `<!doctype html><title>chat</title>${"<p>a line of the page</p>".repeat(80)}`);
  writeFileSync(join(webDir, "assets", "index-abc.js"), SCRIPT);
  writeFileSync(join(webDir, "assets", "dot.png"), Buffer.alloc(4000, 7));
  (s.app.config as { webDir: string }).webDir = webDir;
});
after(async () => {
  await s.close();
  rmSync(webDir, { recursive: true, force: true });
});

interface Raw { status: number; headers: Record<string, string | string[] | undefined>; bytes: Buffer }

function raw(path: string, accept?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(s.base + path, { headers: accept === undefined ? {} : { "accept-encoding": accept } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const decode = (answer: Raw): Buffer => (answer.headers["content-encoding"] === "br" ? brotliDecompressSync(answer.bytes)
  : answer.headers["content-encoding"] === "gzip" ? gunzipSync(answer.bytes) : answer.bytes);

for (const path of ["/api/conversations?archived=1", "/assets/index-abc.js", "/", "/some/client/route"]) {
  test(`${path} answers brotli, gzip or plain by Accept-Encoding, with the same bytes`, async () => {
    const plain = await raw(path);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.ok(plain.bytes.length >= 1_000, `the plain answer is ${plain.bytes.length} bytes`);
    for (const [accept, encoding] of [["gzip, deflate, br, zstd", "br"], ["gzip, deflate", "gzip"], ["br;q=0, gzip", "gzip"], ["identity", undefined]] as const) {
      const answer = await raw(path, accept);
      assert.equal(answer.headers["content-encoding"], encoding, accept);
      assert.equal(answer.headers.vary, "accept-encoding");
      assert.equal(Number(answer.headers["content-length"]), answer.bytes.length);
      assert.equal(answer.headers["content-type"], plain.headers["content-type"]);
      assert.equal(answer.headers["cache-control"], plain.headers["cache-control"]);
      if (encoding) assert.ok(answer.bytes.length < plain.bytes.length / 2, `${encoding} sent ${answer.bytes.length} of ${plain.bytes.length} bytes`);
      // The sidebar's times move between two reads, so a JSON answer is compared as it parses.
      if (path.startsWith("/api/")) assert.deepEqual(JSON.parse(decode(answer).toString()), JSON.parse(plain.bytes.toString()));
      else assert.deepEqual(decode(answer), plain.bytes);
    }
  });
}

test("an answer that fits one packet, an image and an error keep their form", async () => {
  const ready = await raw("/api/ready", "br, gzip");
  assert.equal(ready.headers["content-encoding"], undefined);
  // The server runs in this process, and a release reads the pid to tell the new server from the old one (441a0866).
  assert.deepEqual(JSON.parse(ready.bytes.toString()), { ready: true, pid: process.pid });
  const image = await raw("/assets/dot.png", "br, gzip");
  assert.equal(image.headers["content-encoding"], undefined);
  assert.equal(image.bytes.length, 4000);
  const missing = await raw("/api/c/no-such-thread", "br, gzip");
  assert.ok(missing.status >= 400);
  assert.equal(typeof JSON.parse(decode(missing).toString()).error, "string");
});

test("a changed file is compressed again", async () => {
  const first = await raw("/assets/index-abc.js", "br");
  writeFileSync(join(webDir, "assets", "index-abc.js"), `${SCRIPT}export const more = ${JSON.stringify("x".repeat(500))};\n`);
  const second = await raw("/assets/index-abc.js", "br");
  assert.notDeepEqual(decode(second), decode(first));
  assert.ok(decode(second).toString().includes("export const more"));
});
