/**
 * An image's width and height from its file header, with no decode, so the web client draws each image's box at its final size before the
 * bytes arrive. On 11-20 the screenshots in #sw-factory-build loaded after their rows drew and grew each row by about 250 px, which moved
 * every post below them. PNG, GIF, WebP and JPEG are read; a JPEG whose EXIF orientation turns it sideways answers its shown size, as
 * browsers rotate it by default (`image-orientation: from-image`). SVG and anything unknown answer undefined and draw as before.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { ImageRef } from "../web/src/lib/api/types.ts";

export type ImageSize = { width: number; height: number };

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Markers with no length after them. */
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8]);

const sized = (width: number, height: number): ImageSize | undefined => (width > 0 && height > 0 ? { width, height } : undefined);

export function imageSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("latin1", 12, 16) === "IHDR") {
    return sized(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (bytes.length >= 10 && bytes.toString("latin1", 0, 4) === "GIF8") return sized(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  if (bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return webpSize(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  return undefined;
}

function webpSize(bytes: Buffer): ImageSize | undefined {
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8X") return sized(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!];
    return sized(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
  }
  if (chunk === "VP8 ") return sized(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  return undefined;
}

function jpegSize(bytes: Buffer): ImageSize | undefined {
  let orientation = 1;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (STANDALONE.has(marker)) {
      i += 2;
      continue;
    }
    const length = bytes.readUInt16BE(i + 2);
    if (marker === 0xe1 && bytes.toString("latin1", i + 4, i + 10) === "Exif\0\0") orientation = exifOrientation(bytes, i + 10, i + 2 + length) ?? orientation;
    if (SOF.has(marker) && i + 9 <= bytes.length) {
      const height = bytes.readUInt16BE(i + 5);
      const width = bytes.readUInt16BE(i + 7);
      return orientation >= 5 && orientation <= 8 ? sized(height, width) : sized(width, height);
    }
    i += 2 + length;
  }
  return undefined;
}

/** The orientation tag (0x0112) of IFD0 in the TIFF block at `start`, or undefined. */
function exifOrientation(bytes: Buffer, start: number, end: number): number | undefined {
  if (end > bytes.length || start + 8 > end) return undefined;
  const little = bytes.toString("latin1", start, start + 2) === "II";
  const u16 = (at: number) => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
  const u32 = (at: number) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  const ifd = start + u32(start + 4);
  if (ifd + 2 > end) return undefined;
  const count = u16(ifd);
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > end) return undefined;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return undefined;
}

/** How much of a file the header read takes first; a JPEG with a larger EXIF block before its frame header is read whole. */
const HEAD_BYTES = 256 * 1024;

/** The size from a file's header, or undefined when the file is missing or of no type above. */
export function fileImageSize(path: string): ImageSize | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const total = statSync(path).size;
    const head = Buffer.alloc(Math.min(total, HEAD_BYTES));
    readSync(fd, head, 0, head.length, 0);
    const size = imageSize(head);
    if (size || total <= head.length || head[0] !== 0xff) return size;
    const all = Buffer.alloc(total);
    readSync(fd, all, 0, total, 0);
    return imageSize(all);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The ref with its size, from the ref itself or else from `read`; a ref whose size stays unknown comes back unchanged. */
export function withSize(ref: ImageRef, read: () => ImageSize | undefined): ImageRef {
  if (ref.width && ref.height) return ref;
  const size = read();
  return size ? { ...ref, ...size } : ref;
}
