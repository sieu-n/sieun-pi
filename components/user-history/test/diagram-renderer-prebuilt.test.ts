// Guards 10-27: each chat release compiled the 5.3 MB diagram renderer on the first diagram after it, render.js took 1.2 to 2.3 s at 17:57,
// 18:06 and 18:16Z, and d7 counted each of those minutes dirty. The release now writes the renderer, and a start reads it.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildRenderBundle, writeRenderer } from "../src/chat-render.ts";

test("a start reads the release's prebuilt renderer and its gzip instead of compiling it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "renderer-prebuilt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const body = Buffer.from("window.prebuiltRenderer = true;");
  await writeFile(join(dir, "render.js"), body);
  await writeFile(join(dir, "render.js.gz"), gzipSync(body));
  const served = await buildRenderBundle(dir);
  assert.deepEqual(served.body, body);
  assert.deepEqual(gunzipSync(served.gzip!), body);
  assert.match(served.contentType, /javascript/);
});

test("the release writes a renderer and a gzip of it that a start then serves", async t => {
  const dir = await mkdtemp(join(tmpdir(), "renderer-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeRenderer(dir);
  const body = await readFile(join(dir, "render.js"));
  assert.ok(body.length > 1_000_000);
  assert.deepEqual(gunzipSync(await readFile(join(dir, "render.js.gz"))), body);
  assert.deepEqual((await buildRenderBundle(dir)).body, body);
});
