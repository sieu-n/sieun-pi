// Guards 10-20 01:20Z to 01:29Z: the chat reloaded blog signup push 10-19 (01a14c02, on the Mac) through the id of its failed worker at every
// catalog update, and each of its 74 "Session worker is failed" answers made a d7 minute dirty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reloadTarget } from "../src/chat-threads.ts";

test("a job whose worker failed has nothing to reload, even with an attached thread's id", () => {
  assert.equal(reloadTarget({ workerState: "failed", activeSessionId: "a-dead" }, "a-dead"), undefined);
  assert.equal(reloadTarget({ workerState: "failed", activeSessionId: "a-dead" }, undefined), undefined);
});

test("a live job reloads through its attached id first, then the catalog's, and a saved one has none", () => {
  assert.equal(reloadTarget({ workerState: "ready", activeSessionId: "a-cat" }, "a-live"), "a-live");
  assert.equal(reloadTarget({ workerState: "ready", activeSessionId: "a-cat" }, undefined), "a-cat");
  assert.equal(reloadTarget({}, undefined), undefined);
});
