/**
 * A PNG as the smaller WebP the upload sends. On 11-19 the owner, 197 ms from the box, waited 2,093 ms for one POST /api/uploads of a
 * 1,756,844 byte PNG screenshot (3178 x 2282); Chrome's WebP at quality 0.9 makes that shot 235,458 bytes at 40.1 dB PSNR with its text as
 * sharp at 2x zoom, where quality 1 (lossless) keeps 1,012,878 bytes and JPEG at 0.9 keeps 473,741. The pixel size stays, so an agent reads
 * the same shot. Any other type, a browser that cannot write WebP, an image that fails to decode and a WebP that is no smaller all upload
 * the file as it is.
 */
const WEBP_QUALITY = 0.9;

export async function shrink(file: Blob): Promise<Blob> {
  if (file.type !== "image/png" || typeof OffscreenCanvas === "undefined") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const webp = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
    return webp.type === "image/webp" && webp.size < file.size ? webp : file;
  } catch {
    return file;
  }
}
