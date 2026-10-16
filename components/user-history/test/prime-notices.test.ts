import assert from "node:assert/strict";
import test from "node:test";
import { shortNotice, shortNotices } from "../src/prime-notices.ts";

const STATE = "[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available. " +
  "Variables above the per-variable snapshot limit were removed: big. These names are still defined: a, b_2, websearch.";
const REFINE = { role: "custom", customType: "refinement_notice", content: "[auto-refinement]\n\nAdd a memory.\n- create memory [local:x] X: long edit text ...",
  details: { refinementId: "refine_1", summary: "Add a memory." }, timestamp: 5 };

test("prime notices: python-state keeps the pruned list and replaces the names with a count", () => {
  assert.equal(shortNotice({ role: "custom", customType: "ipython_state", content: STATE }),
    "[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available. " +
    "Variables above the per-variable snapshot limit were removed: big. 3 names are still defined; run dir() to list them.");
  const restored = "[python-state-restored]\n\nYour Python kernel state was revived from your previous session. These names are available again: x, y.\nThese could not be restored and must be recreated if needed: z.";
  assert.equal(shortNotice({ role: "custom", customType: "ipython_state_restored", content: restored }),
    "[python-state-restored]\n\nYour Python kernel state was revived from your previous session. 2 names are available again; run dir() to list them.\n" +
    "These could not be restored and must be recreated if needed: z.");
  assert.equal(shortNotice({ role: "custom", customType: "ipython_state", content: "[python-state]\n\nYou have not defined any names yet." }), null);
});

test("prime notices: a refinement notice becomes its title, id and the entries it saved", () => {
  assert.equal(shortNotice(REFINE), "[auto-refinement] Refinement saved: Add a memory. (refine_1)");
  assert.equal(shortNotice({ ...REFINE, details: { ...REFINE.details, edits: [{ action: "create", kind: "prompt", id: "no_bold_in_owner_replies" }, { action: "delete", kind: "memory", id: "old" }] } }),
    "[auto-refinement] Refinement saved: Add a memory. (refine_1); entries: prompt:no_bold_in_owner_replies, deleted memory:old");
  assert.equal(shortNotice({ ...REFINE, details: undefined }), "[auto-refinement] Refinement saved: Add a memory.");
});

test("prime notices: the result is the same on every call and the input is never changed, so the cached prefix holds", () => {
  const user = { role: "user", content: STATE };
  const messages = [user, { role: "custom", customType: "ipython_state", content: STATE }, REFINE];
  const copy = structuredClone(messages);
  const first = shortNotices(messages)!;
  assert.deepEqual(shortNotices(messages), first);
  assert.deepEqual(messages, copy, "input untouched");
  assert.equal(first[0], user, "a user message that quotes the notice stays as it is");
  assert.deepEqual(shortNotices(first), undefined, "a short notice is left alone");
  assert.equal(shortNotices([user]), undefined);
});
