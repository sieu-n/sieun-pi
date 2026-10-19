import { createHash } from "node:crypto";

// Prime resizes terminal pastes and @file images, but not images sent through the
// daemon prompt API (browser chat) or returned by tools. Anthropic rejects any image
// over 2000 px once a request carries more than 20 images, so one full-size
// screenshot breaks every later turn of its thread.

export interface ContextImage { type: "image"; data: string; mimeType: string }
export type FitImage = (image: ContextImage) => Promise<ContextImage>;

export const MAX_IMAGE_EDGE = 2000;
export const IMAGE_CACHE_ENTRIES = 256;

type Photon = typeof import("@silvia-odwyer/photon-node");
let photon: Promise<Photon> | undefined;

// A dynamic import: Prime's own createRequire-based photon loader returns null inside the Bun binary.
function loadPhoton(): Promise<Photon> {
  photon ??= import("@silvia-odwyer/photon-node").then(module => ("default" in module ? module.default : module) as Photon);
  return photon;
}

export async function fitImageEdge(image: ContextImage, maxEdge = MAX_IMAGE_EDGE): Promise<ContextImage> {
  const { PhotonImage, resize, SamplingFilter } = await loadPhoton();
  const source = PhotonImage.new_from_byteslice(new Uint8Array(Buffer.from(image.data, "base64")));
  try {
    const width = source.get_width();
    const height = source.get_height();
    const scale = maxEdge / Math.max(width, height);
    if (scale >= 1) return image;
    const fitted = resize(source, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), SamplingFilter.Lanczos3);
    try {
      const jpeg = image.mimeType === "image/jpeg";
      const bytes = jpeg ? fitted.get_bytes_jpeg(85) : fitted.get_bytes();
      return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: jpeg ? "image/jpeg" : "image/png" };
    } finally {
      fitted.free();
    }
  } finally {
    source.free();
  }
}

/** The pixel size a PNG, GIF or JPEG header names, or undefined for another format or a header it cannot read. */
export function imageSize(image: ContextImage): { width: number; height: number } | undefined {
  const bytes = Buffer.from(image.data.slice(0, 1 << 16), "base64");
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && bytes.toString("latin1", 0, 3) === "GIF") return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return undefined;
}

/**
 * What goes in place of an image the fit failed on: the image itself when its header shows it fits, else a text line. On 10-19 from 15:56Z
 * frontend bro (01a11ba8) failed every turn with "messages.44.content.1.image ... exceed max allowed size for many-image requests: 3000 pixels"
 * on the owner's 3600 x 2214 screenshot, because its worker's fit failed and the unfitted image went out on every call.
 */
export type Fitted = ContextImage | { type: "text"; text: string };

export class ImageFitter {
  private readonly cache = new Map<string, Promise<Fitted>>();

  constructor(private readonly fit: FitImage = fitImageEdge, private readonly limit = IMAGE_CACHE_ENTRIES, private readonly log: (line: string) => void = () => {}) {}

  /** The image fitted to MAX_IMAGE_EDGE. A failed fit is not kept, so the next call tries again. */
  image(image: ContextImage): Promise<Fitted> {
    const key = createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex");
    let fitted = this.cache.get(key);
    if (!fitted) {
      fitted = this.fit(image).catch(error => {
        this.cache.delete(key);
        const size = imageSize(image);
        const why = error instanceof Error ? error.message : String(error);
        this.log(`context image ${key.slice(0, 12)} ${size ? `${size.width}x${size.height}` : "of unknown size"} (${image.mimeType}): fit failed: ${why}`);
        if (size && Math.max(size.width, size.height) <= MAX_IMAGE_EDGE) return image;
        return { type: "text" as const, text: `[An image${size ? ` of ${size.width} x ${size.height} px` : ""} was left out of this request: it may be over ` +
          `${MAX_IMAGE_EDGE} px, and shrinking it failed (${why}).]` };
      });
      this.cache.set(key, fitted);
      if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
    }
    return fitted;
  }

  // Replaces oversized images in place; returns undefined when nothing changed.
  async messages<T>(messages: T[]): Promise<T[] | undefined> {
    let changed = false;
    for (const message of messages) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (let index = 0; index < content.length; index++) {
        const part = content[index] as Partial<ContextImage> | null;
        if (part?.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string") continue;
        const fitted = await this.image({ type: "image", data: part.data, mimeType: part.mimeType });
        if (fitted.type === "text") content[index] = fitted;
        else if (fitted.data === part.data) continue;
        else content[index] = { ...part, data: fitted.data, mimeType: fitted.mimeType };
        changed = true;
      }
    }
    return changed ? messages : undefined;
  }
}
