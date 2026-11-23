import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { conversation, open, tag } from "./helpers";

/**
 * A post's box screenshot and attached upload load as sized copies (server/image-rendition.ts, markdown.ts `sizedImage`), never as the full
 * files, and the screenshot's box has its size before its bytes arrive. On 11-23 a fresh open of a thread with full-size screenshots moved
 * 1.7 MB to draw them at most 480 px wide (work/p231-slow-calls).
 */
test("a post's screenshot and upload load as sized WebP copies, and the lightbox opens the full file", async ({ page, request }, info) => {
  const bytes = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toBuffer();
  const shot = info.outputPath("shot.png");
  writeFileSync(shot, bytes);
  const ref = await (await request.post("/api/uploads?name=upload.png", { data: bytes, headers: { "content-type": "image/png" } })).json();
  const room = ((await (await request.post("/api/rooms", { data: { kind: "channel", name: `sized-${tag()}`, members: [], test: true } })).json()) as { id: string }).id;
  const word = `sized ${tag()}`;
  await request.post(`/api/c/${room}/send`, { data: { text: `${word} ![panel](${shot})`, images: [ref], requestId: `sized-${tag()}` } });

  const images: { url: string; type: string; bytes: number }[] = [];
  page.on("response", async (res) => {
    if (!/\/api\/(local-image|uploads\/)/.test(res.url())) return;
    images.push({ url: res.url(), type: res.headers()["content-type"] ?? "", bytes: (await res.body().catch(() => Buffer.alloc(0))).length });
  });
  await open(page, `#/c/${room}`);
  const post = conversation(page).locator(".row").filter({ hasText: word });
  const screenshot = post.locator("img.md-image");
  await expect(screenshot).toHaveAttribute("width", "1600");
  await expect(screenshot).toHaveAttribute("height", "1000");
  await expect(screenshot).toHaveAttribute("srcset", /&w=480 1x, .*&w=960 2x$/);
  await expect.poll(() => screenshot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(480);
  const attached = post.locator(".image img");
  await expect.poll(() => attached.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(360);

  await expect.poll(() => images.length).toBeGreaterThanOrEqual(2);
  for (const image of images) {
    expect(image.url, "every image the post loads is a sized copy").toMatch(/[?&]w=\d+/);
    expect(image.type).toBe("image/webp");
    expect(image.bytes).toBeLessThan(bytes.length / 4);
  }

  const full = page.waitForResponse((res) => res.url().includes("/api/local-image") && !/[?&]w=/.test(res.url()));
  await screenshot.click();
  expect((await (await full).body()).length, "the lightbox opens the file itself").toBe(bytes.length);
  await request.patch(`/api/rooms/${room}`, { data: { archived: true } });
});
