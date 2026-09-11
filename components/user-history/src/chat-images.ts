import type { DaemonAgentConnection } from "prime-agent";

type NativeImage = NonNullable<NonNullable<Parameters<DaemonAgentConnection["prompt"]>[1]>["images"]>[number];
type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type ChatImage = NativeImage & { mimeType: ImageMimeType };

export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_CHAT_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ENCODED_IMAGE_BYTES = Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageMimeType(value: unknown): value is ImageMimeType {
  return value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp";
}

function hasImageSignature(bytes: Buffer, mimeType: ImageMimeType): boolean {
  switch (mimeType) {
    case "image/png":
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case "image/gif":
      return bytes.length >= 6 && (bytes.toString("latin1", 0, 6) === "GIF87a" || bytes.toString("latin1", 0, 6) === "GIF89a");
    case "image/webp":
      return bytes.length >= 16 && bytes.toString("latin1", 0, 4) === "RIFF" &&
        bytes.toString("latin1", 8, 12) === "WEBP" &&
        ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("latin1", 12, 16));
  }
}

function parseImage(value: unknown, remainingBytes: number): { image: ChatImage; byteLength: number } {
  if (!isRecord(value) || value.type !== "image" || !isImageMimeType(value.mimeType) || typeof value.data !== "string") {
    throw new Error("Attach a PNG, JPEG, GIF, or WebP image in native image format");
  }
  const { data, mimeType } = value;
  if (data.length > MAX_ENCODED_IMAGE_BYTES) throw new Error("Each image must be 3 MiB or smaller");
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error("Image data must be valid base64");
  }
  const byteLength = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (byteLength > MAX_CHAT_IMAGE_BYTES) throw new Error("Each image must be 3 MiB or smaller");
  if (byteLength > remainingBytes) throw new Error("Images must total 8 MiB or less");
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new Error("Image data must be valid base64");
  if (!hasImageSignature(bytes, mimeType)) throw new Error("Image bytes do not match its PNG, JPEG, GIF, or WebP type");
  return { image: { type: "image", data, mimeType }, byteLength };
}

export function parseChatImages(value: unknown): ChatImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Images must be an array");
  if (value.length > MAX_CHAT_IMAGES) throw new Error("Attach up to 4 images per message");
  const images: ChatImage[] = [];
  let totalBytes = 0;
  for (const candidate of value) {
    const { image, byteLength } = parseImage(candidate, MAX_CHAT_TOTAL_IMAGE_BYTES - totalBytes);
    images.push(image);
    totalBytes += byteLength;
  }
  return images;
}

export function sanitizeNativeImages(message: unknown): ChatImage[] {
  if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) return [];
  const images: ChatImage[] = [];
  let totalBytes = 0;
  for (const candidate of message.content) {
    if (!isRecord(candidate) || candidate.type !== "image") continue;
    if (images.length >= MAX_CHAT_IMAGES) break;
    try {
      const { image, byteLength } = parseImage(candidate, MAX_CHAT_TOTAL_IMAGE_BYTES - totalBytes);
      images.push(image);
      totalBytes += byteLength;
    } catch {
      continue;
    }
  }
  return images;
}

export function chatImageDataUrl(image: ChatImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}
