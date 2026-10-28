import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/desktop");
const config = JSON.parse(readFileSync(join(app, "src-tauri/tauri.conf.json"), "utf8"));

test("the desktop Tauri config names the app and loads the box's https chat URL", () => {
  assert.equal(config.productName, "sw factory");
  assert.equal(config.identifier, "com.sieun.chat", "the bundle id keeps the saved window state and the chat login");
  assert.match(config.identifier, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  const main = config.app.windows.find((window) => window.label === "main");
  assert.ok(main, "tauri.conf.json has a main window");
  assert.equal(main.create, false, "src-tauri/src/main.rs builds the main window itself");
  const url = new URL(main.url);
  assert.equal(url.protocol, "https:");
  assert.equal(main.titleBarStyle, "Overlay");
  assert.equal(main.hiddenTitle, true);
});

test("the box's chat page may drag the window", () => {
  const main = config.app.windows.find((window) => window.label === "main");
  const capability = JSON.parse(readFileSync(join(app, "src-tauri/capabilities/main.json"), "utf8"));
  assert.deepEqual(capability.windows, ["main"]);
  assert.deepEqual(capability.remote.urls, [new URL(main.url).origin]);
  assert.ok(capability.permissions.includes("core:window:allow-start-dragging"));
});

test("the desktop Tauri config points at files that exist", () => {
  assert.ok(existsSync(join(app, "src-tauri", config.build.frontendDist, "index.html")));
  for (const icon of config.bundle.icon) assert.ok(existsSync(join(app, "src-tauri", icon)), icon);
});
