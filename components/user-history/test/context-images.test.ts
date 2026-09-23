import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { fitImageEdge, ImageFitter, MAX_IMAGE_EDGE, type ContextImage } from "../src/context-images.ts";

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngImage(width: number, height: number): ContextImage {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 90)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0)),
  ]);
  return { type: "image", mimeType: "image/png", data: bytes.toString("base64") };
}

function pngSize(image: ContextImage): [number, number] {
  const bytes = Buffer.from(image.data, "base64");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("a retina screenshot shrinks to fit the 2000 px many-image limit", async () => {
  const fitted = await fitImageEdge(pngImage(2620, 1788));
  assert.equal(fitted.mimeType, "image/png");
  assert.deepEqual(pngSize(fitted), [MAX_IMAGE_EDGE, 1365]);
});

test("an image within the limit is returned unchanged", async () => {
  const image = pngImage(1200, 750);
  assert.equal(await fitImageEdge(image), image);
});

test("the fitter rewrites oversized user and tool images and reports no change otherwise", async () => {
  const calls: string[] = [];
  const fitter = new ImageFitter(async image => {
    calls.push(image.data);
    return image.data === "big" ? { type: "image", data: "small", mimeType: "image/jpeg" } : image;
  });
  const messages = [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "big", mimeType: "image/png" }] },
    { role: "toolResult", content: [{ type: "image", data: "ok", mimeType: "image/png" }] },
    { role: "assistant", content: "plain text" },
  ];
  const fitted = await fitter.messages(messages);
  assert.deepEqual(fitted?.[0]?.content, [{ type: "text", text: "look" }, { type: "image", data: "small", mimeType: "image/jpeg" }]);
  assert.deepEqual(fitted?.[1]?.content, [{ type: "image", data: "ok", mimeType: "image/png" }]);
  assert.equal(await fitter.messages([{ role: "user", content: [{ type: "image", data: "ok", mimeType: "image/png" }] }]), undefined);
  assert.deepEqual(calls, ["big", "ok"], "each distinct image is fitted once");
});

test("an image the resizer cannot decode passes through", async () => {
  const fitter = new ImageFitter();
  const broken = { role: "user", content: [{ type: "image", data: "bm90IGFuIGltYWdl", mimeType: "image/png" }] };
  assert.equal(await fitter.messages([broken]), undefined);
});
