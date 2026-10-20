// 10-19 14:48Z: the AI harness chat sent correction_add with id c133, mergeInto c110 and its owner's words in one call, guessing its new rule's id.
// c133 was frontend bro's 13:13Z rule (a duty guards a whole system), so the merge folded it into c110 as a repeat the owner never gave, and
// repeat_corrections_7d counted it, while the owner's own 13:48Z words were lost.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCorrection, parseCorrectionCall, type Correction, type Ledger } from "../src/chat-corrections.ts";

const vp = { id: "01a1164b-4a2d-742d-b27a-82f086ed0200", name: "AI harness developer environment VP" };
const fb = { id: "01a11ba8-9d2c-727c-8ded-38f819ca9f29", name: "frontend bro" };
const VP_WORDS = "plan should be tasks all eventually clear - duties are things that need constant montiroing thus set a heartbeat. things like \"i need to keep X working\" should NOT be registered as a zombie plan. ALL PLANS SHOULD BE EPHEMERAL, and the Chat (and Chat-check-in) MUST BE DESIGNED SO THAT IT ACTIVELY PERSUES AND CLEARS ALL THE TASKS.";
const c110 = (): Correction => ({ id: "c110", at: "2026-10-18T10:43:04.742Z", chat: vp, words: "a chat is a VP/TL responsible of a certain project scope. plan is meant to all be done",
  rule: "A chat's plan holds only finishable work from the owner's requests.", enforcedBy: "brief", ref: "brief", status: "active", theme: ["plan", "duty"], repeats: [] });
const c133 = (): Correction => ({ id: "c133", at: "2026-10-19T13:13:01.142Z", chat: fb, words: "이런건duty라고 하기에 짜치잖니^^",
  rule: "A duty keeps a whole system the owner cares about working.", enforcedBy: "brief", ref: "msg mvf9ul12", status: "active", theme: ["duty"], repeats: [] });

test("a merge whose words are not the entry's is refused and the ledger stays as it was (c133 into c110, 10-19 14:48Z)", () => {
  const ledger: Ledger = { corrections: [c110(), c133()] };
  const before = structuredClone(ledger);
  const call = parseCorrectionCall({ id: "c133", mergeInto: "c110", words: VP_WORDS, rule: "Plans are ephemeral.", theme: "ephemeral plans upkeep in duties", ref: "mvfb7zt0" });
  assert.throws(() => applyCorrection(ledger, call, vp, "2026-10-19T14:48:27.187Z"), /c133 holds other words .* no id/);
  assert.deepEqual(ledger, before);
});

test("a merge of the entry's own words, or with no words, still folds it into the other entry", () => {
  for (const words of ["이런건duty라고  하기에 짜치잖니^^", undefined]) {
    const ledger: Ledger = { corrections: [c110(), c133()] };
    const outcome = applyCorrection(ledger, parseCorrectionCall({ id: "c133", mergeInto: "c110", ...(words === undefined ? {} : { words }) }), fb, "2026-10-19T13:14:00Z");
    assert.equal(outcome.kind, "repeat");
    assert.deepEqual(ledger.corrections.map(entry => entry.id), ["c110"]);
    assert.equal(ledger.corrections[0]!.repeats[0]!.words, "이런건duty라고 하기에 짜치잖니^^");
  }
});
