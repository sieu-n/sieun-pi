// Guards 11-04: each read of idleEvictionMinutes built a SettingsManager, which took proper-lockfile's lock (a mkdir and an rmdir in
// ~/.prime/agent) on the chat's main thread, and one such mkdir held it 2.9 s at 04:28:55Z on us-metal02 (d7 clean_min_30, p1432).
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsManager } from "prime-agent";
import { chatDefaultsStore } from "../src/chat-backend.ts";

function agentDir(settings: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "idle-eviction-read-"));
  if (settings !== null) writeFileSync(join(dir, "settings.json"), settings);
  return dir;
}

/** Writes the file the way Prime does, a temp file renamed over it. */
function replace(dir: string, settings: string): void {
  writeFileSync(join(dir, "settings.json.tmp"), settings);
  renameSync(join(dir, "settings.json.tmp"), join(dir, "settings.json"));
}

test("50 idle eviction reads of an unchanged file take no settings lock and parse the file once", t => {
  const dir = agentDir(JSON.stringify({ idleEvictionMinutes: 30 }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = chatDefaultsStore(dir);
  const created = t.mock.method(SettingsManager, "create");
  const parsed = t.mock.method(SettingsManager, "inMemory");
  for (let n = 0; n < 50; n++) assert.equal(store.idleEviction(), 30);
  assert.equal(created.mock.callCount(), 0, "no read built a locking SettingsManager");
  assert.equal(parsed.mock.callCount(), 1, "the file was parsed once");
});

test("an idle eviction read sees each new file, a missing one and a bad one as Prime loads them", t => {
  const dir = agentDir(JSON.stringify({ idleEvictionMinutes: 30 }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fallback = SettingsManager.inMemory({}).getIdleEvictionMinutes();
  const store = chatDefaultsStore(dir);
  assert.equal(store.idleEviction(), 30);
  replace(dir, JSON.stringify({ idleEvictionMinutes: "off" }));
  assert.equal(store.idleEviction(), "off");
  replace(dir, "{ not json");
  assert.equal(store.idleEviction(), fallback);
  rmSync(join(dir, "settings.json"));
  assert.equal(store.idleEviction(), fallback);
});

test("setIdleEviction is read back at once", async t => {
  const dir = agentDir(JSON.stringify({ idleEvictionMinutes: 30 }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = chatDefaultsStore(dir);
  assert.equal(store.idleEviction(), 30);
  await store.setIdleEviction(45);
  assert.equal(store.idleEviction(), 45);
  await store.setIdleEviction("off");
  assert.equal(store.idleEviction(), "off");
});
