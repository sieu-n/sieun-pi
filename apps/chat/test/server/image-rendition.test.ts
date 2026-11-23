/**
 * Sized copies of box images and uploads (server/image-rendition.ts): `GET /api/local-image?path=&w=` and `GET /api/uploads/<file>?w=` answer
 * the image at that width, built once into `<data dir>/renditions`, while the routes without `w` still answer the file's exact bytes.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/image-rendition.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import type { ImageRef, Item, TimelinePage } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
let dir: string;
before(async () => {
  s = await start();
  dir = mkdtempSync(join(tmpdir(), "apps-chat-rendition-"));
});
after(async () => {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A screenshot-sized PNG of noise, so it compresses as little as a real one. */
const png = (width: number, height: number, mean = 128) =>
  sharp({ create: { width, height, channels: 3, background: "#808080", noise: { type: "gaussian", mean, sigma: 40 } } }).png().toBuffer();
const WEBP = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
const local = (path: string, query = "", accept = WEBP, headers: Record<string, string> = {}) =>
  fetch(`${s.base}/api/local-image?path=${encodeURIComponent(path)}${query}`, { headers: { accept, ...headers } });
const kept = () => {
  const folder = join(s.app.config.dataDir, "renditions");
  return readdirSync(folder).filter(name => !name.endsWith(".tmp")).map(name => ({ name, mtimeMs: statSync(join(folder, name)).mtimeMs }));
};

test("a box screenshot at w=480 comes back as a 480 px WebP built once, and the file itself still comes back byte for byte", async () => {
  const shot = join(dir, "shot.png");
  const bytes = await png(1200, 800);
  writeFileSync(shot, bytes);

  const first = await local(shot, "&w=480");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/webp");
  assert.match(first.headers.get("vary") ?? "", /accept/i);
  const small = Buffer.from(await first.arrayBuffer());
  const meta = await sharp(small).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 480, 320]);
  assert.ok(small.length < bytes.length / 4, `${small.length} bytes against the file's ${bytes.length}`);
  const built = kept();
  assert.equal(built.length, 1, "one rendition on disk");

  const second = await local(shot, "&w=480");
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), small);
  assert.deepEqual(kept(), built, "the second ask built nothing and rewrote nothing");

  const again = await local(shot, "&w=480", WEBP, { "if-none-match": first.headers.get("etag")! });
  assert.equal(again.status, 304, "the browser's copy is still the rendition");

  const whole = await local(shot);
  assert.equal(whole.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes, "the route without w answers the exact file");
});

test("a changed file at the same path builds again, and a width rounds up to a multiple of 40", async () => {
  const shot = join(dir, "changing.png");
  writeFileSync(shot, await png(1000, 1000));
  const first = await local(shot, "&w=470");
  assert.equal((await sharp(Buffer.from(await first.arrayBuffer())).metadata()).width, 480);
  const before = kept().length;

  writeFileSync(shot, await png(1600, 800, 90));
  const changed = await local(shot, "&w=480", WEBP, { "if-none-match": first.headers.get("etag")! });
  assert.equal(changed.status, 200, "the new file is not the browser's copy");
  const meta = await sharp(Buffer.from(await changed.arrayBuffer())).metadata();
  assert.deepEqual([meta.width, meta.height], [480, 240]);
  assert.equal(kept().length, before + 1, "the new bytes got their own rendition");
});

test("a browser that takes no WebP gets the file's own type at the width, and SVG, a bad w and a fake image answer as before", async () => {
  const shot = join(dir, "plain.png");
  writeFileSync(shot, await png(900, 600));
  const res = await local(shot, "&w=320", "image/png,image/*;q=0.8");
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width, 320);

  const svg = join(dir, "panel.svg");
  writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  const drawn = await local(svg, "&w=480");
  assert.equal(drawn.headers.get("content-type"), "image/svg+xml");
  assert.equal(await drawn.text(), readFileSync(svg, "utf8"));

  assert.equal((await local(shot, "&w=wide")).status, 400);
  const fake = join(dir, "key.png");
  writeFileSync(fake, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  assert.equal((await local(fake, "&w=480")).status, 415);
});

test("an upload at w=360 comes back as a sized WebP that keeps for a year, and the upload itself stays byte for byte", async () => {
  const bytes = await png(1400, 700);
  const up = await fetch(`${s.base}/api/uploads?name=shot.png`, { method: "POST", headers: { "content-type": "image/png" }, body: bytes });
  const ref = (await up.json()) as ImageRef;
  assert.deepEqual([ref.width, ref.height], [1400, 700]);

  const sized = await fetch(`${s.base}${ref.url}?w=360`, { headers: { accept: WEBP } });
  assert.equal(sized.headers.get("content-type"), "image/webp");
  assert.match(sized.headers.get("cache-control") ?? "", /immutable/);
  const meta = await sharp(Buffer.from(await sized.arrayBuffer())).metadata();
  assert.deepEqual([meta.width, meta.height], [360, 180]);

  const whole = await fetch(`${s.base}${ref.url}`, { headers: { accept: WEBP } });
  assert.equal(whole.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
});

test("a post that links a box screenshot carries its size, so the page draws its box before the bytes arrive", async () => {
  const shot = join(dir, "sized.png");
  writeFileSync(shot, await png(1280, 800));
  const room = (await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: `sizes-${Date.now()}`, members: [], test: true })).body.id;
  await s.send("POST", `/api/c/${room}/send`, { text: `the panel: ![panel](${shot}) and ${join(dir, "missing.png")}`, images: [], requestId: `sizes-${Date.now()}` });
  const page = await s.get<TimelinePage>(`/api/c/${room}/items`);
  const post = page.items.find((i): i is Extract<Item, { kind: "message" }> => i.kind === "message" && i.text.includes("the panel"));
  assert.ok(post, "the post is in the room");
  assert.deepEqual(post.imageSizes, { [shot]: { width: 1280, height: 800 } });
});
