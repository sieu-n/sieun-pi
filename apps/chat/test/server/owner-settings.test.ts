/**
 * The owner's settings on the server (server/owner-settings.ts): a PATCH replaces the parts it names and marks them set by hand, every save
 * goes out to the pages, and a browser's old localStorage copies merge in without losing a status, a pause or a search.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/owner-settings.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { OwnerSettingsStore } from "../../server/owner-settings.ts";
import { Store } from "../../server/store.ts";
import type { SavedSettings } from "../../web/src/lib/api/shared/owner-settings.ts";

const dirs: string[] = [];
after(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));

function rig(): { settings: OwnerSettingsStore; sent: SavedSettings[]; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), "owner-settings-"));
  dirs.push(dir);
  const store = new Store(dir);
  const sent: SavedSettings[] = [];
  return { settings: new OwnerSettingsStore(store, s => sent.push(s)), sent, store };
}

const NOW = 1_000_000;

test("defaults before anything is set", () => {
  const { settings } = rig();
  assert.deepEqual(settings.get(NOW), { presence: { away: false }, notify: { level: "direct", badge: true }, recentSearches: [], rev: 0, edited: {} });
});

test("a patch replaces only the parts it names, counts the save and sends it", () => {
  const { settings, sent, store } = rig();
  const saved = settings.patch({ presence: { away: true, status: { emoji: "🌴", text: "Off", until: NOW + 60_000 } }, junk: 1 }, NOW);
  assert.equal(saved.rev, 1);
  assert.deepEqual(saved.presence, { away: true, status: { emoji: "🌴", text: "Off", until: NOW + 60_000 } });
  assert.deepEqual(saved.notify, { level: "direct", badge: true });
  assert.deepEqual(saved.edited, { presence: NOW });
  assert.deepEqual(sent, [saved]);
  assert.deepEqual(store.state.ownerSettings, saved);
  const next = settings.patch({ notify: { level: "off", badge: false } }, NOW + 1);
  assert.equal(next.rev, 2);
  assert.equal(next.presence.away, true);
  assert.deepEqual(next.notify, { level: "off", badge: false });
});

test("a status or pause that ran out reads as none", () => {
  const { settings } = rig();
  settings.patch({ presence: { away: false, status: { emoji: "🍜", text: "Lunch", until: NOW + 10 } }, notify: { level: "all", badge: true, pausedUntil: NOW + 10 } }, NOW);
  const later = settings.get(NOW + 11);
  assert.equal(later.presence.status, undefined);
  assert.deepEqual(later.notify, { level: "all", badge: true });
});

test("old copies fill what the server lacks, and every recent search survives", () => {
  const { settings } = rig();
  settings.importOld({
    presence: { away: false, status: { emoji: "🎧", text: "Focus" } },
    notify: { level: "off", badge: true, pausedUntil: NOW + 500 },
    recentSearches: [{ q: "deploy", filters: { from: "vent" } }, { q: "meili", filters: {} }],
  }, NOW);
  const merged = settings.importOld({
    presence: { away: true },
    notify: { level: "direct", badge: false, pausedUntil: NOW + 900 },
    recentSearches: [{ q: "Deploy", filters: { from: "vent" } }, { q: "proxy", filters: { has: "link" } }],
  }, NOW);
  assert.deepEqual(merged.presence, { away: true, status: { emoji: "🎧", text: "Focus" } });
  assert.deepEqual(merged.notify, { level: "off", badge: false, pausedUntil: NOW + 900 });
  assert.deepEqual(merged.recentSearches.map(s => s.q), ["deploy", "meili", "proxy"]);
  assert.deepEqual(merged.edited, {});
});

test("a part set by hand since the move is newer than any old copy", () => {
  const { settings } = rig();
  settings.patch({ notify: { level: "all", badge: true }, recentSearches: [{ q: "new", filters: {} }] }, NOW);
  const merged = settings.importOld({ notify: { level: "off", badge: false }, recentSearches: [{ q: "old", filters: {} }] }, NOW + 1);
  assert.deepEqual(merged.notify, { level: "all", badge: true });
  assert.deepEqual(merged.recentSearches.map(s => s.q), ["new", "old"]);
});

test("the list keeps 10 searches", () => {
  const { settings } = rig();
  const many = Array.from({ length: 14 }, (_, i) => ({ q: `q${i}`, filters: {} }));
  assert.equal(settings.patch({ recentSearches: many }, NOW).recentSearches.length, 10);
});

test("a restore puts back the stamps too, so an old copy still moves up after a walk", () => {
  const { settings } = rig();
  const before = settings.get(NOW);
  settings.patch({ presence: { away: true }, notify: { level: "all", badge: true } }, NOW);
  const restored = settings.replace(before, NOW + 1);
  assert.deepEqual(restored.edited, {});
  assert.equal(restored.rev, 2);
  const merged = settings.importOld({ presence: { away: false, status: { emoji: "🎧", text: "Focus" } }, notify: { level: "off", badge: true } }, NOW + 2);
  assert.deepEqual(merged.presence, { away: false, status: { emoji: "🎧", text: "Focus" } });
  assert.equal(merged.notify.level, "off");
});
