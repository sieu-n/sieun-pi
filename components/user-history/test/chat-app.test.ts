import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { appAsset, appManifest } from "../src/chat-assets.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { iconPng } from "../src/chat-icon.ts";
import { findInstalledApp } from "../src/chat-open.ts";
import { contentSecurityPolicy, startChatServer } from "../src/chat-server.ts";

/** RGBA of one pixel of a PNG that iconPng wrote (filter 0 on every row). */
function pixel(png: Buffer, x: number, y: number): number[] {
  const size = png.readUInt32BE(16);
  const idat = png.indexOf("IDAT");
  const rows = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  const at = y * (size * 4 + 1) + 1 + x * 4;
  return [...rows.subarray(at, at + 4)];
}

test("the app icons are square RGBA PNGs: a rounded tile with transparent corners, a full-bleed tile for masks, and an edge-to-edge favicon", () => {
  for (const size of [180, 192, 512]) {
    const any = iconPng(size, "any");
    assert.deepEqual([...any.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(any.readUInt32BE(16), size);
    assert.equal(any.readUInt32BE(20), size);
    assert.equal(pixel(any, 0, 0)[3], 0, "the corner outside the tile is transparent");
    assert.deepEqual(pixel(any, Math.round(size * 0.5), Math.round(size * 0.5)), [255, 255, 255, 255], "the spark is white");
    assert.equal(pixel(iconPng(size, "full"), 0, 0)[3], 255, "the maskable icon fills its corners");
  }
  for (const size of [32, 64]) {
    const favicon = iconPng(size, "favicon");
    assert.equal(pixel(favicon, 0, 0)[3], 0, "the favicon has rounded corners");
    const [r, g, b, a] = pixel(favicon, size / 2, 1);
    assert.equal(a, 255, "the favicon tile reaches the edge, so it reads at 16 px");
    assert(b! > r! && r! > g!, "the favicon tile is violet");
  }
});

test("the manifest makes the capability path an installable standalone app with 192 and 512 px icons", () => {
  assert.equal(appManifest.start_url, "./");
  assert.equal(appManifest.scope, "./");
  assert.equal(appManifest.display, "standalone");
  for (const icon of appManifest.icons) assert(appAsset(icon.src), `${icon.src} is served`);
  assert(appManifest.icons.some(icon => icon.sizes === "192x192" && icon.purpose === "any"));
  assert(appManifest.icons.some(icon => icon.sizes === "512x512" && icon.purpose === "any"));
  assert.equal(appAsset("app.js"), undefined, "only app files come from appAsset");
  assert.match(contentSecurityPolicy, /manifest-src 'self'/, "the strict policy allows the same-origin manifest");
});

test("the server serves the manifest and icons under the capability path, and the shell links them", async () => {
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const backend = { close: async () => {} } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t", app: appAsset }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  try {
    const manifest = await fetch(server.url + "manifest.webmanifest", { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "manifest" } });
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type") ?? "", /^application\/manifest\+json/);
    assert.equal((await manifest.json() as { start_url: string }).start_url, "./");
    const icon = await fetch(server.url + "icon-512.png");
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await icon.arrayBuffer()).readUInt32BE(16), 512);
    const shell = await fetch(server.url);
    assert.match(shell.headers.get("content-security-policy") ?? "", /manifest-src 'self'/);
    const html = await shell.text();
    assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="apple-touch-icon.png">/);
    assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="favicon-32.png">/);
    assert.equal((await fetch(server.url + "favicon-32.png")).status, 200);
    assert.equal((await fetch(new URL("/manifest.webmanifest", server.url))).status, 404, "nothing is served outside the capability path");
  } finally { await server.close(); }
});

test("chat open finds the app a Chromium browser installed for the chat URL", { skip: process.platform !== "darwin" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "chat-open-"));
  try {
    const plist = (url: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0"><dict><key>CrAppModeShortcutURL</key><string>${url}</string></dict></plist>\n`;
    const install = async (folder: string, name: string, url: string) => {
      const contents = join(home, "Applications", folder, name, "Contents");
      await mkdir(contents, { recursive: true });
      await writeFile(join(contents, "Info.plist"), plist(url));
    };
    await install("Chrome Apps.localized", "Other.app", "https://example.com/");
    await install("Aside Apps.localized", "Agent chat.app", "http://127.0.0.1:5182/abc/");
    assert.equal(await findInstalledApp("http://127.0.0.1:5182/abc/", home), join(home, "Applications", "Aside Apps.localized", "Agent chat.app"));
    assert.equal(await findInstalledApp("http://127.0.0.1:5182/other/", home), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});
