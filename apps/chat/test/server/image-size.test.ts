/**
 * Image sizes from file headers (server/image-size.ts): every type the chat shows, a sideways JPEG, a JPEG whose frame header sits past the
 * first read, and the backfill that gives a stored post from before sizes were kept its image's size.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/image-size.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileImageSize, imageSize, withSize } from "../../server/image-size.ts";
import { AgentStore } from "../../server/agent-store.ts";

const dir = mkdtempSync(join(tmpdir(), "image-size-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function webp(chunk: "VP8X" | "VP8L" | "VP8 ", width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write(chunk, 12, "latin1");
  if (chunk === "VP8X") {
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
  } else if (chunk === "VP8L") {
    b[20] = 0x2f;
    const w = width - 1, h = height - 1;
    b[21] = w & 0xff;
    b[22] = ((w >> 8) & 0x3f) | ((h & 0x3) << 6);
    b[23] = (h >> 2) & 0xff;
    b[24] = (h >> 10) & 0x0f;
  } else {
    b.writeUInt16LE(width, 26);
    b.writeUInt16LE(height, 28);
  }
  return b;
}

const segment = (marker: number, body: Buffer): Buffer => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};

function exif(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  return segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]));
}

function jpeg(width: number, height: number, before: Buffer[] = []): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...before, segment(0xc2, sof), Buffer.from([0xff, 0xd9])]);
}

test("the header gives the size of a PNG, GIF, WebP and JPEG", () => {
  assert.deepEqual(imageSize(png(1600, 900)), { width: 1600, height: 900 });
  assert.deepEqual(imageSize(gif(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(imageSize(webp("VP8X", 2048, 1536)), { width: 2048, height: 1536 });
  assert.deepEqual(imageSize(webp("VP8L", 1000, 3000)), { width: 1000, height: 3000 });
  assert.deepEqual(imageSize(webp("VP8 ", 640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageSize(jpeg(400, 300)), { width: 400, height: 300 });
  assert.equal(imageSize(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), undefined);
  assert.equal(imageSize(Buffer.alloc(0)), undefined);
});

test("a JPEG that EXIF turns sideways answers the size it shows at", () => {
  assert.deepEqual(imageSize(jpeg(4032, 3024, [exif(6)])), { width: 3024, height: 4032 });
  assert.deepEqual(imageSize(jpeg(4032, 3024, [exif(1)])), { width: 4032, height: 3024 });
});

test("a file is read from its header, and whole only when a JPEG's frame header sits past the first read", () => {
  const big = jpeg(1200, 800, Array.from({ length: 5 }, () => segment(0xfe, Buffer.alloc(65_000))));
  assert.ok(big.length > 256 * 1024);
  writeFileSync(join(dir, "big.jpg"), big);
  assert.deepEqual(fileImageSize(join(dir, "big.jpg")), { width: 1200, height: 800 });
  assert.equal(fileImageSize(join(dir, "missing.png")), undefined);
});

test("a ref keeps a size it has and gains one it lacks", () => {
  assert.deepEqual(withSize({ url: "/x.png", mimeType: "image/png", width: 5, height: 6 }, () => ({ width: 1, height: 1 })), { url: "/x.png", mimeType: "image/png", width: 5, height: 6 });
  assert.deepEqual(withSize({ url: "/x.png", mimeType: "image/png" }, () => ({ width: 1, height: 1 })), { url: "/x.png", mimeType: "image/png", width: 1, height: 1 });
  assert.deepEqual(withSize({ url: "/x.png", mimeType: "image/png" }, () => undefined), { url: "/x.png", mimeType: "image/png" });
});

test("a stored post from before sizes were kept reads its upload's size from the file", () => {
  const data = join(dir, "data");
  mkdirSync(join(data, "images"), { recursive: true });
  mkdirSync(join(data, "rooms"), { recursive: true });
  writeFileSync(join(data, "images", "shot.png"), png(1600, 900));
  const post = { id: "p1", seq: 1, room: "ch_old", author: "owner", text: "look", at: 1, requestId: "r1",
    images: [{ url: "/api/uploads/shot.png", mimeType: "image/png" }, { url: "/api/uploads/gone.png", mimeType: "image/png" }] };
  writeFileSync(join(data, "rooms", "ch_old.jsonl"), `${JSON.stringify({ t: "post", post })}\n`);
  const [read] = new AgentStore(data).postsOf("ch_old");
  assert.deepEqual(read!.images, [
    { url: "/api/uploads/shot.png", mimeType: "image/png", width: 1600, height: 900 },
    { url: "/api/uploads/gone.png", mimeType: "image/png" },
  ]);
});
