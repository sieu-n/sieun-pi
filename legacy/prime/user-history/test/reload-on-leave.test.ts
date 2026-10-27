// Guards the 10-18 owner report on us-metal02 ("the web server sieu-pi keep crashing"): each of the 42 chat restarts by 06:15Z reloaded every
// page in view, which blanked it, dropped its scroll and showed a spinner until the open chat came back. A page in view now reloads when he leaves it.
// Also guards the 10-18 11:00Z Mac overload: the owner's chat window, loaded at 06:36Z with a draft in it, only offered Reload once and stayed on
// that code through every release, with one renderer at 160% CPU and 2.4 GB. A draft now rides the reload, and a busy page waits instead of giving up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReload } from "../src/client/build-reload.ts";
import { drafts, restoreDrafts, saveDrafts } from "../src/client/drafts.ts";

test("new client code reloads a page in view once the owner leaves it, a page out of view at once, and a busy page after it is idle", () => {
  assert.equal(buildReload({ hidden: false, focused: true, busy: false }), "on-leave");
  assert.equal(buildReload({ hidden: true, focused: false, busy: false }), "now");
  assert.equal(buildReload({ hidden: false, focused: false, busy: false }), "now");
  assert.equal(buildReload({ hidden: false, focused: true, busy: true }), "wait");
  assert.equal(buildReload({ hidden: true, focused: false, busy: true }), "wait");
});

test("an unsent draft with its image and quote survives the reload, and an empty one is not kept", () => {
  const box = new Map<string, string>();
  const storage = { getItem: (key: string) => box.get(key) ?? null, setItem: (key: string, value: string) => void box.set(key, value), removeItem: (key: string) => void box.delete(key) };
  drafts.clear();
  drafts.set("chat:a", { text: "half a reply", images: [{ id: 7, name: "shot.png", mimeType: "image/png", size: 3, data: "AAAA", url: "blob:old" }], quote: "the quoted line" });
  drafts.set("chat:b", { text: "  ", images: [], quote: null });
  assert.equal(saveDrafts(storage), true);
  drafts.clear();
  restoreDrafts(storage);
  assert.deepEqual([...drafts.keys()], ["chat:a"]);
  assert.deepEqual(drafts.get("chat:a"), { text: "half a reply", images: [{ id: 7, name: "shot.png", mimeType: "image/png", size: 3, data: "AAAA", url: "data:image/png;base64,AAAA" }], quote: "the quoted line" });
  assert.equal(box.size, 0);
});

test("a draft storage refuses (images past its quota) keeps the page from reloading", () => {
  const storage = { getItem: () => null, setItem: () => { throw new DOMException("quota", "QuotaExceededError"); }, removeItem: () => {} };
  drafts.clear();
  drafts.set("chat:a", { text: "keep me", images: [], quote: null });
  assert.equal(saveDrafts(storage), false);
});
