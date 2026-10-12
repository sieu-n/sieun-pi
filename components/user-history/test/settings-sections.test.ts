import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ICON_PATHS } from "../src/client/icons.ts";
import { SETTINGS_SECTIONS, settingsSection } from "../src/client/settings-sections.ts";

const CLIENT = join(import.meta.dirname, "../src/client");

test("Settings tabs keep their order, with How it works last", () => {
  assert.deepEqual(SETTINGS_SECTIONS.map(entry => entry.id), ["accounts", "usage", "new-chats", "appearance", "remote", "slack", "machine", "updates", "how"]);
});

test("every Settings tab has a label, a description and a drawn icon", () => {
  for (const entry of SETTINGS_SECTIONS) {
    assert.ok(entry.label.trim(), entry.id);
    assert.ok(entry.description.trim().endsWith("."), entry.id);
    assert.ok(Object.hasOwn(ICON_PATHS, entry.icon), `${entry.id} icon ${entry.icon}`);
    assert.equal(settingsSection(entry.id), entry);
  }
  assert.equal(new Set(SETTINGS_SECTIONS.map(entry => entry.icon)).size, SETTINGS_SECTIONS.length, "each tab has its own icon");
});

test("every tab the client opens with store.drawer is a Settings tab", () => {
  const ids = new Set<string>(SETTINGS_SECTIONS.map(entry => entry.id));
  const opened: string[] = [];
  for (const file of readdirSync(CLIENT, { recursive: true, encoding: "utf8" })) {
    if (!/\.(svelte|ts)$/.test(file)) continue;
    for (const match of readFileSync(join(CLIENT, file), "utf8").matchAll(/store\.drawer\s*=\s*"([^"]+)"/g)) opened.push(`${file}: ${match[1]}`);
  }
  assert.ok(opened.length >= 3, `found ${opened.length} callers`);
  for (const entry of opened) assert.ok(ids.has(entry.split(": ")[1]!), entry);
});
