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
