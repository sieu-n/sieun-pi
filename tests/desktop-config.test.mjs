import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/desktop");
const config = JSON.parse(readFileSync(join(app, "src-tauri/tauri.conf.json"), "utf8"));

test("the desktop Tauri config names the app and loads the box's https chat URL", () => {
  assert.equal(config.productName, "Sieun Chat");
  assert.match(config.identifier, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  const main = config.app.windows.find((window) => window.label === "main");
  assert.ok(main, "tauri.conf.json has a main window");
  assert.equal(main.create, false, "src-tauri/src/main.rs builds the main window itself");
  const url = new URL(main.url);
  assert.equal(url.protocol, "https:");
});

test("the desktop Tauri config points at files that exist", () => {
  assert.ok(existsSync(join(app, "src-tauri", config.build.frontendDist, "index.html")));
  for (const icon of config.bundle.icon) assert.ok(existsSync(join(app, "src-tauri", icon)), icon);
});
