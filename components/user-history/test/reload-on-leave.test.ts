// Guards the 10-18 owner report on us-metal02 ("the web server sieu-pi keep crashing"): each of the 42 chat restarts by 06:15Z reloaded every
// page in view, which blanked it, dropped its scroll and showed a spinner until the open chat came back. A page in view now reloads when he leaves it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReload } from "../src/client/build-reload.ts";

test("new client code reloads a page in view only once the owner leaves it, a page out of view at once, and a page with a draft never on its own", () => {
  assert.equal(buildReload({ hidden: false, focused: true, unsent: false }), "on-leave");
  assert.equal(buildReload({ hidden: true, focused: false, unsent: false }), "now");
  assert.equal(buildReload({ hidden: false, focused: false, unsent: false }), "now");
  assert.equal(buildReload({ hidden: false, focused: true, unsent: true }), "offer");
  assert.equal(buildReload({ hidden: true, focused: false, unsent: true }), "offer");
});
