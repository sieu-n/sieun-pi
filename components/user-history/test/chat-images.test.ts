import assert from "node:assert/strict";
import { test } from "node:test";
import type { DaemonAgentConnection } from "prime-agent";
import {
  chatImageDataUrl, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES, MAX_CHAT_TOTAL_IMAGE_BYTES,
  parseChatImages, sanitizeNativeImages, type ChatImage,
} from "../src/chat-images.ts";

const png = {
  type: "image", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
} satisfies ChatImage;
const gif = {
  type: "image", mimeType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
} satisfies ChatImage;
const webp = {
  type: "image", mimeType: "image/webp", data: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
} satisfies ChatImage;

function sizedPng(byteLength: number): ChatImage {
  const bytes = Buffer.alloc(byteLength);
  Buffer.from(png.data, "base64").copy(bytes);
  return { ...png, data: bytes.toString("base64") };
}

function nativeUser(content: unknown[]): unknown {
  return { role: "user", content, timestamp: 1 };
}

test("image parser returns native prompt images without a second representation", () => {
  const inputs = [png, gif, webp];
  const images: NonNullable<NonNullable<Parameters<DaemonAgentConnection["prompt"]>[1]>["images"]> = parseChatImages(inputs);
  assert.deepEqual(images, inputs);
  assert.notEqual(images, inputs);
  assert.notEqual(images[0], png);
  assert.deepEqual(parseChatImages(undefined), []);
  assert.deepEqual(parseChatImages([]), []);
  assert.equal(parseChatImages(Array.from({ length: MAX_CHAT_IMAGES }, () => png)).length, MAX_CHAT_IMAGES);
});

test("image parser recognizes JPEG, GIF87a, and both extended WebP signatures", () => {
  const jpeg = { type: "image", mimeType: "image/jpeg", data: Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]).toString("base64") };
  assert.deepEqual(parseChatImages([jpeg]), [jpeg]);
  const gif87 = Buffer.from(gif.data, "base64");
  gif87.write("GIF87a");
  assert.equal(parseChatImages([{ ...gif, data: gif87.toString("base64") }]).length, 1);
  for (const signature of ["VP8L", "VP8X"]) {
    const bytes = Buffer.from(webp.data, "base64");
    bytes.write(signature, 12);
    assert.equal(parseChatImages([{ ...webp, data: bytes.toString("base64") }]).length, 1);
  }
});

test("image parser rejects wrong containers, unsupported MIME types, and incomplete native shapes", () => {
  for (const input of [null, {}, "image.png", png]) assert.throws(() => parseChatImages(input), /array/);
  for (const image of [null, [], {}, { ...png, type: "text" }, { ...png, mimeType: undefined },
    { ...png, data: 1 }, { mimeType: "image/png", data: png.data }]) {
    assert.throws(() => parseChatImages([image]), /native image format/);
  }
  for (const mimeType of ["image/svg+xml", "text/html", "image/avif", "image/bmp", "image/jpg", "IMAGE/PNG", "image/png;charset=utf-8"]) {
    assert.throws(() => parseChatImages([{ ...png, mimeType }]), /PNG, JPEG, GIF, or WebP/);
  }
});

test("image parser rejects URLs, file paths, raw HTML, and noncanonical base64", () => {
  for (const data of ["", "data:image/png;base64," + png.data, "file:///etc/passwd", "/tmp/image.png",
    "https://example.test/image.png", "<img src=x onerror=alert(1)>", png.data + "\n", png.data.slice(0, -1),
    png.data + "====", "AA=A", "AAAA-___", "AA==\u0000", "AB==", "AAB="]) {
    assert.throws(() => parseChatImages([{ ...png, data }]), /valid base64/);
  }
});

test("image parser verifies bytes rather than trusting the MIME label", () => {
  for (const mimeType of ["image/jpeg", "image/gif", "image/webp"]) {
    assert.throws(() => parseChatImages([{ ...png, mimeType }]), /bytes do not match/);
  }
  for (const text of ["<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "<!doctype html>", "plain text"]) {
    assert.throws(() => parseChatImages([{ ...png, data: Buffer.from(text).toString("base64") }]), /bytes do not match/);
  }
  const riff = Buffer.from(webp.data, "base64");
  riff.write("WAVE", 8);
  assert.throws(() => parseChatImages([{ ...webp, data: riff.toString("base64") }]), /bytes do not match/);
  for (const image of [gif, webp]) {
    const bytes = Buffer.from(image.data, "base64");
    bytes[0] = (bytes[0] ?? 0) | 128;
    assert.throws(() => parseChatImages([{ ...image, data: bytes.toString("base64") }]), /bytes do not match/);
  }
});

test("image parser enforces count, decoded per-image bytes, and total bytes at exact boundaries", () => {
  assert.throws(() => parseChatImages(Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => png)), /up to 4/);
  const largest = sizedPng(MAX_CHAT_IMAGE_BYTES);
  assert.deepEqual(parseChatImages([largest]), [largest]);
  assert.throws(() => parseChatImages([sizedPng(MAX_CHAT_IMAGE_BYTES + 1)]), /3 MiB/);
  const remainder = MAX_CHAT_TOTAL_IMAGE_BYTES - 2 * MAX_CHAT_IMAGE_BYTES;
  assert.equal(parseChatImages([largest, largest, sizedPng(remainder)]).length, 3);
  assert.throws(() => parseChatImages([largest, largest, sizedPng(remainder + 1)]), /total 8 MiB/);
});

test("native image projection keeps only safe user images and does not mutate messages", () => {
  const content = [Object.freeze({ type: "text", text: "Look at this" }),
    Object.freeze({ ...png, name: "<img onerror=alert(1)>", path: "/etc/passwd", url: "https://example.test" }),
    Object.freeze({ type: "image", mimeType: "image/svg+xml", data: "not an image" }), null,
    Object.freeze({ ...png, mimeType: "image/jpeg" }), Object.freeze(gif)];
  const message = Object.freeze({ role: "user", content: Object.freeze(content), timestamp: 1 });
  assert.deepEqual(sanitizeNativeImages(message), [png, gif]);
  assert.equal(content.length, 6);
  assert.deepEqual(parseChatImages([content[1]]), [png]);
  for (const role of ["assistant", "toolResult", "custom", undefined]) {
    assert.deepEqual(sanitizeNativeImages({ role, content: [png] }), []);
  }
  for (const value of [null, undefined, [], {}, { role: "user", content: "text" }]) {
    assert.deepEqual(sanitizeNativeImages(value), []);
  }
});

test("native image projection skips invalid and over-limit blocks without hiding later small images", () => {
  assert.equal(sanitizeNativeImages(nativeUser(Array.from({ length: MAX_CHAT_IMAGES + 2 }, () => png))).length, MAX_CHAT_IMAGES);
  assert.deepEqual(sanitizeNativeImages(nativeUser([sizedPng(MAX_CHAT_IMAGE_BYTES + 1), png])), [png]);
  const largest = sizedPng(MAX_CHAT_IMAGE_BYTES);
  assert.deepEqual(sanitizeNativeImages(nativeUser([largest, largest, largest, png])), [largest, largest, png]);
});

test("display URLs are data URLs built from validated native image bytes", () => {
  for (const image of parseChatImages([png, gif, webp])) {
    assert.equal(chatImageDataUrl(image), `data:${image.mimeType};base64,${image.data}`);
    assert.match(chatImageDataUrl(image), /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/);
  }
});
