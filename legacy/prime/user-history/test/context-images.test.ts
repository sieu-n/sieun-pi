// Guards 10-19 15:56Z: frontend bro (01a11ba8) failed every turn with "messages.44.content.1.image ... exceed max allowed size for many-image
// requests: 3000 pixels", because its worker's fit of the owner's 3600 x 2214 screenshot failed and the unfitted image went out on every call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ContextImage, fitImageEdge, ImageFitter, imageSize, MAX_IMAGE_EDGE } from "../src/context-images.ts";

function pngHeader(width: number, height: number): ContextImage {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return { type: "image", data: bytes.toString("base64"), mimeType: "image/png" };
}

function jpegHeader(width: number, height: number): ContextImage {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
  return { type: "image", data: Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]).toString("base64"), mimeType: "image/jpeg" };
}

const owner = (image: ContextImage) => [{ role: "user", content: [{ type: "text", text: "this page" }, { ...image }] }];

test("the header gives a PNG's and a JPEG's pixel size", () => {
  assert.deepEqual(imageSize(pngHeader(3600, 2214)), { width: 3600, height: 2214 });
  assert.deepEqual(imageSize(jpegHeader(4032, 3024)), { width: 4032, height: 3024 });
  assert.equal(imageSize({ type: "image", data: Buffer.from("not an image").toString("base64"), mimeType: "image/webp" }), undefined);
});

test("an oversized image whose fit fails leaves the request as a text line, and the next call tries the fit again", async () => {
  let tries = 0;
  const lines: string[] = [];
  const fitter = new ImageFitter(async () => { tries++; throw new Error("photon failed"); }, 256, line => lines.push(line));
  const messages = owner(pngHeader(3600, 2214));
  assert.ok(await fitter.messages(messages));
  const part = messages[0]!.content[1] as { type: string; text?: string };
  assert.equal(part.type, "text");
  assert.match(part.text!, /3600 x 2214 px was left out/);
  assert.match(lines[0]!, /3600x2214 \(image\/png\): fit failed: photon failed/);
  await fitter.messages(owner(pngHeader(3600, 2214)));
  assert.equal(tries, 2);
});

test("an image that already fits stays when its fit fails", async () => {
  const fitter = new ImageFitter(async () => { throw new Error("photon failed"); });
  const image = pngHeader(1200, 800);
  const messages = owner(image);
  assert.equal(await fitter.messages(messages), undefined);
  assert.deepEqual(messages[0]!.content[1], image);
});

test("the real fit shrinks a wide PNG to the edge limit", async () => {
  const { PhotonImage } = await import("@silvia-odwyer/photon-node");
  const source = new PhotonImage(new Uint8Array(3600 * 40 * 4).fill(200), 3600, 40);
  const image: ContextImage = { type: "image", data: Buffer.from(source.get_bytes()).toString("base64"), mimeType: "image/png" };
  source.free();
  const fitted = await fitImageEdge(image);
  assert.deepEqual(imageSize(fitted), { width: MAX_IMAGE_EDGE, height: 22 });
});

// Guards 11-03: a photon resize on the event loop stalled Prime worker 597bd6f3376c for 5.6 s at 01:23:51Z, 10.0 s at 02:19:51Z and 9.4 s at 02:44:27Z.
test("fitting a big screenshot keeps the event loop ticking, and a second fitter reuses the fit", async () => {
  const { PhotonImage } = await import("@silvia-odwyer/photon-node");
  const width = 3600, height = 2214;
  const pixels = new Uint8Array(width * height * 4);
  for (let at = 0; at < pixels.length; at += 4) {
    const x = (at >> 2) % width, y = Math.floor((at >> 2) / width);
    pixels[at] = (x * 7 + y) & 255; pixels[at + 1] = ((x >> 4) ^ (y >> 3)) & 255; pixels[at + 2] = (x * y) & 255; pixels[at + 3] = 255;
  }
  const source = new PhotonImage(pixels, width, height);
  const image: ContextImage = { type: "image", data: Buffer.from(source.get_bytes()).toString("base64"), mimeType: "image/png" };
  source.free();
  let last = performance.now(), worst = 0;
  const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 10);
  const fitted = await new ImageFitter().image(image);
  worst = Math.max(worst, performance.now() - last);
  clearInterval(tick);
  assert.deepEqual(imageSize(fitted as ContextImage), { width: MAX_IMAGE_EDGE, height: 1230 });
  // The old on-loop fit blocked 2,208 ms here; a 206 ms tick gap came from 20 concurrent test files on a busy box (release-chat 03:35Z 11-03).
  assert.ok(worst < 1000, `the event loop stalled ${Math.round(worst)} ms`);
  let fits = 0;
  await new ImageFitter(async image => { fits++; return image; }).image(image);
  assert.equal(fits, 1, "a fitter with its own fit keeps its own cache");
  assert.equal(await new ImageFitter().image(image), fitted);
});

test("an image whose header shows it fits comes back without a decode", async () => {
  const image = pngHeader(1200, 800);
  assert.equal(await fitImageEdge(image), image);
});
