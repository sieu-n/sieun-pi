// Shrinks one context image on its own thread for src/context-images.ts, so the decode, resize and encode never block a Prime worker's event loop.
import { parentPort, workerData } from "node:worker_threads";
import photon from "@silvia-odwyer/photon-node";

const { PhotonImage, resize, SamplingFilter } = photon;
const { data, mimeType, maxEdge } = workerData;

function fit() {
  const source = PhotonImage.new_from_byteslice(new Uint8Array(Buffer.from(data, "base64")));
  try {
    const width = source.get_width();
    const height = source.get_height();
    const scale = maxEdge / Math.max(width, height);
    if (scale >= 1) return { fits: true };
    // Triangle shrinks a 3600 x 2214 PNG in half the time Lanczos3 takes (1.1 s against 2.1 s), and a model reads both the same.
    const fitted = resize(source, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), SamplingFilter.Triangle);
    try {
      const jpeg = mimeType === "image/jpeg";
      const bytes = jpeg ? fitted.get_bytes_jpeg(85) : fitted.get_bytes();
      return { data: Buffer.from(bytes).toString("base64"), mimeType: jpeg ? "image/jpeg" : "image/png" };
    } finally {
      fitted.free();
    }
  } finally {
    source.free();
  }
}

try {
  parentPort.postMessage(fit());
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
