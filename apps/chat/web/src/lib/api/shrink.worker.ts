/**
 * Encodes a PNG as WebP off the page's main thread (shrink.ts) and answers on the port the request brought: the WebP, or nothing when the
 * image did not decode or the browser cannot write WebP.
 */
addEventListener("message", (event: MessageEvent<{ file: Blob; quality: number; port: MessagePort }>) => {
  const { file, quality, port } = event.data;
  void (async () => {
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.convertToBlob({ type: "image/webp", quality });
  })().then(webp => port.postMessage(webp.type === "image/webp" ? webp : undefined), () => port.postMessage(undefined));
});
