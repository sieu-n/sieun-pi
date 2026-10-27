// Compares pi-harness with Prime 0.9.8's own host functions. fixtures/prime-parity.json was generated from the functions in the
// prime-agent binary (qFn, jFn, JFn, VFn, YFn, UFn, eUn, IZs, iUn, mZs, EZs, gZs, GFn) run on fixtures/global and fixtures/local;
// the generator is in /home/sieun/work/pi-migration-build/step-4/parity/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mergeStates, readState, type HarnessState } from "../src/store.ts";
import { buildDelta, buildDigest, fingerprint, plannerOverview, queryTermsOf } from "../src/digest.ts";
import { applyProposal, historyText, invalidEdit, noticeBody, parseProposal, parseRefineArgs, parseReview, rollbackProposal, type RefineResult } from "../src/refine.ts";

const fx = join(import.meta.dirname, "fixtures");
const gold = JSON.parse(readFileSync(join(fx, "prime-parity.json"), "utf8"));
const load = () => ({ global: readState(join(fx, "global"), "global"), local: readState(join(fx, "local"), "local") });
const merged = () => { const { global, local } = load(); return mergeStates(global, local); };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const withoutTimes = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "created_at" || k === "updated_at" ? undefined : x)));

test("the digest matches Prime's for every option set, ranked and unranked", () => {
  for (const { opts, digest } of gold.digests) {
    const options = { ...opts, queryTerms: opts.queryTerms ? new Map(opts.queryTerms) : undefined };
    assert.equal(buildDigest(merged(), options), digest);
  }
});

test("the fingerprint matches Prime's", () => {
  gold.digests.forEach(({ opts }: { opts: Record<string, unknown> }, i: number) => {
    const { queryTerms, ...flags } = opts;
    assert.equal(fingerprint(merged(), flags), gold.fingerprints[i]);
  });
});

test("the [harness-digest update] delta matches Prime's, and an unchanged state has none", () => {
  const delivered = [buildDigest(merged(), {})];
  const changed = clone(merged()) as HarnessState;
  changed.entries.memory.memory_global_0 = { ...changed.entries.memory.memory_global_0, content: "changed content", version: 9, updated_at: "2026-10-27T00:00:00+00:00" };
  delete changed.entries.prompt.prompt_global_1;
  changed.entries.memory.fresh = { ...changed.entries.memory.memory_global_2, id: "fresh", title: "Fresh one", updated_at: "2026-10-27T01:00:00+00:00" };
  changed.refinements.push({ id: "refine_new", trigger: "New one", changes: ["create memory:fresh"], outcome: "better", created_at: "2026-10-27T02:00:00+00:00" });
  const since = Date.parse("2026-10-26T00:00:00Z");
  assert.equal(buildDelta(changed, delivered, since), gold.delta);
  assert.equal(buildDelta(merged(), delivered, since) ?? null, gold.noDelta);
});

test("the planner overview, history text and query terms match Prime's", () => {
  assert.equal(plannerOverview(merged()), gold.overview);
  const history = [
    { id: "refine_a", summary: "A", expectedOutcome: "E", appliedEdits: [{ applied: true, action: "create", kind: "memory", id: "x" }, { applied: false, action: "update", kind: "prompt", id: "y" }] },
    { id: "refine_b", rollbackOf: "refine_a", summary: "B", expectedOutcome: "F", appliedEdits: [] },
  ] as unknown as RefineResult[];
  assert.equal(historyText(history), gold.historyText);
  assert.deepEqual(queryTermsOf("Hello wörld 修复login naïve мир abc 登录故障"), gold.terms);
});

test("/refine arguments parse as Prime parses them", () => {
  for (const { a, r } of gold.args) assert.deepEqual(clone(parseRefineArgs(a)), r);
  for (const { a, error } of gold.argErrors) assert.throws(() => parseRefineArgs(a), { message: error });
});

test("planner and review replies parse as Prime parses them", () => {
  const replies = ['{"summary":"s","edits":[]}', 'Here:\n```json\n{"summary":"t","rationale":"r","edits":[{"action":"create","kind":"memory","title":"T","content":"C"}]}\n```', 'prose {"summary":"u","edits":[{"action":"delete","kind":"memory","id":"x"},5]} tail'];
  replies.forEach((reply, i) => assert.deepEqual(JSON.parse(JSON.stringify(parseProposal(reply))), gold.proposals[i]));
  ['{"shouldRefine":true,"rationale":"r","instructions":"i"}', '{"shouldRefine":"yes"}'].forEach((reply, i) => assert.deepEqual(JSON.parse(JSON.stringify(parseReview(reply))), gold.reviews[i]));
});

test("edit validation, apply, rollback and the notice match Prime's", () => {
  const edits = [
    { action: "create", kind: "memory", title: "New thing", content: "c" },
    { action: "update", kind: "memory", id: "memory_local_0", title: "T2", content: "C2" },
    { action: "delete", kind: "memory", id: "memory_local_1" },
    { action: "delete", kind: "memory", id: "missing" },
    { action: "update", kind: "prompt", id: "base_system_prompt", title: "x", content: "y" },
    { action: "create", kind: "skill", title: "S", content: "c" },
    { action: "create", kind: "skill", title: "S2", content: "c", reference: { type: "python", import: "a", callable: "b" }, arguments: {} },
    { action: "create", kind: "memory", id: "memory_local_2", title: "dup", content: "dup" },
    { action: "rename", kind: "memory", id: "q" },
  ] as never[];
  edits.forEach((e: { id?: string }, i) => assert.equal(invalidEdit(e as never, e.id ?? "") ?? null, gold.validation[i] ?? null));
  const target = load().local;
  const result = applyProposal(target, { summary: "S", rationale: "R", expectedOutcome: "E", edits }, { id: "refine_t", scope: "local" });
  assert.deepEqual(withoutTimes(result), withoutTimes(gold.applied));
  assert.deepEqual(withoutTimes(target), withoutTimes(gold.afterApply));
  assert.deepEqual(withoutTimes(rollbackProposal(result)), withoutTimes(gold.rollback));
  assert.equal(noticeBody(result), gold.notice);
});
