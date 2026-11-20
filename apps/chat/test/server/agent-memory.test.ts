/**
 * The recall read of `scripts/duties/agent-memory.ts`: a recall session's turn counts as answered only once it is not live and holds an
 * answer, a stop or an error. On 11-20 a fresh test thread read as an empty, not-live turn while its run worked, and the precheck graded
 * 4 of 7 sessions as "(nothing)" though each answered moments later.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { finishedReply, splitAnswers } from "../../scripts/duties/agent-memory.ts";

const ask = { kind: "message", text: "Quick questions" };

test("an empty turn that reads not live is still running", () => {
  assert.equal(finishedReply([ask, { kind: "turn", live: false, text: "", usage: { cost: 0 } }]), null);
  assert.equal(finishedReply([ask, { kind: "turn", live: false, text: "", sent: [], usage: { cost: 0 } }]), null);
});

test("a live turn is running even with text", () => {
  assert.equal(finishedReply([ask, { kind: "turn", live: true, text: "1. No." }]), null);
  assert.equal(finishedReply([ask]), null);
});

test("a finished turn gives its text, its sent posts and its cost", () => {
  const done = finishedReply([ask, { kind: "turn", live: false, text: "1. No.\n2. Yes.", usage: { cost: 0.36 } }]);
  assert.deepEqual(done, { reply: "1. No.\n2. Yes.", cost: 0.36 });
  assert.deepEqual(splitAnswers(done!.reply, 2).map(answer => answer.trim()), ["No.", "Yes."]);
  const spoken = finishedReply([ask, { kind: "turn", live: false, text: "1. No.", sent: ["1. No.", "2. Yes."] }]);
  assert.equal(spoken?.reply, "1. No.\n2. Yes.");
});

test("a turn that failed with no answer ends with its error", () => {
  assert.deepEqual(finishedReply([ask, { kind: "turn", live: false, text: "", error: "The model call failed.", stop: "error" }]), { reply: "", error: "The model call failed." });
  assert.deepEqual(finishedReply([ask, { kind: "turn", live: false, text: "", stop: "aborted" }]), { reply: "", error: "turn aborted" });
});

test("a turn that answered before it stopped keeps its answer", () => {
  assert.deepEqual(finishedReply([ask, { kind: "turn", live: false, text: "1. No.", stop: "aborted" }]), { reply: "1. No." });
});
