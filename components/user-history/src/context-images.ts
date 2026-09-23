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

export class ImageFitter {
  private readonly cache = new Map<string, Promise<ContextImage>>();

  constructor(private readonly fit: FitImage = fitImageEdge, private readonly limit = IMAGE_CACHE_ENTRIES) {}

  image(image: ContextImage): Promise<ContextImage> {
    const key = createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex");
    let fitted = this.cache.get(key);
    if (!fitted) {
      fitted = this.fit(image).catch(() => image);
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
        if (fitted.data === part.data) continue;
        content[index] = { ...part, data: fitted.data, mimeType: fitted.mimeType };
        changed = true;
      }
    }
    return changed ? messages : undefined;
  }
}
