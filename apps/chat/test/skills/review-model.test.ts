import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewCopy, ReviewItemSummary } from "../../web/src/lib/api/shared/skills-review.ts";
import { commandFor, diffCounts, diffLines, editProblem, macText, neighbor, nextPending, overridesOf, pickItem } from "../../web/src/pages/skills-review/model.ts";

const summary = (id: string, status: ReviewItemSummary["status"]): ReviewItemSummary => ({
  id, title: id, unit: "skill", group: null, status, copies: 2, toAct: 1, bytes: 10, boxes: ["us-metal02"], queued: false,
});
const copy = (id: string, over: Partial<ReviewCopy> = {}): ReviewCopy => ({
  id, box: "us-metal02", path: `/x/${id}/SKILL.md`, family: "sieun-pi", kind: "ours", sizeBytes: 10, lines: 1, files: 1, lastUse: null, uses30d: 0,
  lastChange: null, proposed: "delete", action: "delete", foldInto: null, reason: "", how: "trash", keeper: false, state: "pending", note: null, ...over,
});

test("keys map to commands, except with a modifier or inside a field", () => {
  const key = (k: string, over: Record<string, unknown> = {}) => commandFor({ key: k, metaKey: false, ctrlKey: false, altKey: false, target: null, ...over });
  assert.equal(key("a"), "approve");
  assert.equal(key("e"), "keep");
  assert.equal(key("j"), "next");
  assert.equal(key("x"), null);
  assert.equal(key("a", { metaKey: true }), null);
  assert.equal(key("a", { isComposing: true }), null);
  const field = { closest: (selector: string) => (selector.includes("input") ? {} : null) };
  assert.equal(key("a", { target: field }), null);
});

test("the address picks its item, else the first pending one, and Approve moves to the next pending one with wrap", () => {
  const items = [summary("a", "approved"), summary("b", "pending"), summary("c", "skipped"), summary("d", "pending")];
  assert.equal(pickItem(items, "c"), "c");
  assert.equal(pickItem(items, "gone"), "b");
  assert.equal(pickItem([], undefined), null);
  assert.equal(nextPending(items, "b"), "d");
  assert.equal(nextPending(items, "d"), "b");
  assert.equal(nextPending([summary("a", "approved")], "a"), null);
  assert.equal(neighbor(items, "a", -1), null);
  assert.equal(neighbor(items, "a", 1), "b");
});

test("only changed edits travel as overrides, and a fold needs a target", () => {
  const copies = [copy("1"), copy("2", { action: "fold", proposed: "fold", foldInto: "tsc" }), copy("3", { keeper: true, action: "keep", proposed: "keep" })];
  const same = { "1": { action: "delete" as const, foldInto: "" }, "2": { action: "fold" as const, foldInto: "tsc" } };
  assert.deepEqual(overridesOf(copies, same), {});
  assert.deepEqual(overridesOf(copies, { ...same, "1": { action: "keep", foldInto: "junk" } }), { "1": { action: "keep", foldInto: null } });
  assert.deepEqual(overridesOf(copies, { ...same, "2": { action: "fold", foldInto: " lint " } }), { "2": { action: "fold", foldInto: "lint" } });
  assert.match(editProblem(copies, { ...same, "1": { action: "fold", foldInto: "" } }) ?? "", /folds into/);
  assert.equal(editProblem(copies, same), null);
});

test("a unified diff splits into colored kinds and counts", () => {
  const lines = diffLines("--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n+more\n");
  assert.deepEqual(lines.map(line => line.kind), ["meta", "meta", "hunk", "same", "del", "add", "add"]);
  assert.deepEqual(diffCounts(lines), { added: 2, removed: 1 });
});

test("the Mac line says whether it answers and what waits for it", () => {
  assert.equal(macText({ host: "mac", online: false, checkedAt: null, queued: 3 }), "Mac offline, 3 copies queued");
  assert.equal(macText({ host: "mac", online: true, checkedAt: null, queued: 0 }), "Mac online");
  assert.equal(macText({ host: null, online: null, checkedAt: null, queued: 1 }), "Mac state unknown, 1 copy queued");
});
