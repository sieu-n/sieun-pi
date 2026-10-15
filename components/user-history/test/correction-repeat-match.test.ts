import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCorrection, type ChatRef, type Correction, correctionResult, type Ledger, parseCorrectionCall } from "../src/chat-corrections.ts";

const OPS: ChatRef = { id: "01a11af8-962e-773d-a19a-ee4104011987", name: "ops guy (+observability)" };
const CI: ChatRef = { id: "01a1180e-6567-747f-bf44-452520ebdd1b", name: "VP of CI" };
/** c32, c44, c47 and c61 as the live ledger holds them, before any repeat. */
const C32: Correction = {"id": "c32", "at": "2026-10-09T21:53:55.449Z", "chat": {"id": "01a1180e-6567-747f-bf44-452520ebdd1b", "name": "VP of CI"}, "words": "unslop easy word", "rule": "For you questions use short, easy everyday words a non-engineer reads in one pass, with no internal names like probe slots, land flow or key lock.", "enforcedBy": "test", "ref": "sieun-pi a46dee3 (c32-review-asks.test.ts: a review, look or pick todo with no link and a todo with internal terms are refused; the check-in flags a passed browser check whose look step has no todo)", "status": "active", "theme": ["todo", "plain", "easy", "word"], "repeats": []};
const C44: Correction = {"id": "c44", "at": "2026-10-12T02:17:51.646Z", "chat": {"id": "01a1164b-4a2d-742d-b27a-82f086ed0200", "name": "AI harness developer environment VP"}, "words": "p253 같은 이상한거 지우고, plan 제대로 hierarchy 정리해", "rule": "The plan has a few area goals with their open steps under them; a goal whose work is shipped is closed or folded, never left open with a stale or orphan step, and new work goes under the goal it belongs to instead of a new top-level goal.", "enforcedBy": "code", "ref": "sieun-pi 3671dd1 (stale steps listed by the check-in, target 0; brief bullet pinned; npm test 554/554), plus 0cb0054 finished_open", "status": "active", "theme": ["board", "plan", "hierarchy", "stale", "goal"], "repeats": []};
const C47: Correction = {"id": "c47", "at": "2026-10-12T06:01:43.213Z", "chat": {"id": "01a1180e-6567-747f-bf44-452520ebdd1b", "name": "VP of CI"}, "words": "stop making up these bullshit rules on waiting, ... being overly careful unless explicitly asked.", "rule": "Do not invent waiting rules, extra review rounds or safety gates; act directly and ship, unless the owner explicitly asks for caution.", "enforcedBy": "code", "ref": "sieun-pi c709ef0 + 5a14c3d + aff4b28: board, brief check and agent messages to jobs refuse a wait for another thread's go; tests c47-no-wait-for-leave.test.ts, c47-steer-waits.test.ts", "status": "active", "theme": ["invented", "waiting", "rule", "overly", "careful", "gate"], "repeats": []};
const C61: Correction = {"id": "c61", "at": "2026-10-13T09:57:05.379Z", "chat": {"id": "01a1164b-4a2d-742d-b27a-82f086ed0200", "name": "AI harness developer environment VP"}, "words": "the titles should be human-readable (like fix bug in X, instead of the internal file name , /...)", "rule": "Board step and goal titles are plain, human-readable outcomes (like \"Fix a bug in X\"), with no internal file names, paths, run ids or code names; those belong in the note.", "enforcedBy": "code", "ref": "sieun-pi b9c8d99 chat_board title refusal, test c61-plain-titles.test.ts", "status": "active", "theme": ["board", "title", "plain", "readable"], "repeats": []};
const ledger = (): Ledger => ({ corrections: [C32, C44, C47, C61].map(entry => structuredClone(entry)) });
/** ops guy's call at 2026-10-15T08:28:00Z, after the owner asked "why don't you use the Plan scratchpad by the way?" (msg mv9a0a5n). */
const SCRATCHPAD = { words: "why don't you use the Plan scratchpad by the way?", rule: "Each decision the chat makes itself (a ruling between threads, a land order, " +
  "a skipped re-probe, a kept or dropped limit) goes into the board scratchpad as a dated note in the same turn, not only into step notes or job messages.",
  theme: "board", enforcedBy: "brief", ref: "mv9a0a5n" };
const AT = "2026-10-15T08:28:00.390Z";
const byId = (state: Ledger, id: string) => state.corrections.find(entry => entry.id === id)!;

test("ops guy's scratchpad rule with theme board (10-15) is a new rule, not a repeat of c61 plain titles, and the result names the closest earlier rule", () => {
  const state = ledger();
  const outcome = applyCorrection(state, parseCorrectionCall(SCRATCHPAD), OPS, AT);
  assert.equal(outcome.kind, "added");
  assert.equal(outcome.entry.id, "c62");
  assert.deepEqual([byId(state, "c61").status, byId(state, "c61").repeats], ["active", []], "c61 stays active with no repeat");
  assert.match(correctionResult(outcome), /^Recorded c62: Each decision .* The closest earlier rule is (c\d+) ".+"\. If the owner repeated that rule, call correction_add with id "c62" and mergeInto "\1"\.$/);
  const themed = applyCorrection(ledger(), parseCorrectionCall({ ...SCRATCHPAD, theme: "board plan scratchpad decision note" }), OPS, AT);
  assert.equal(themed.kind, "added", "board, plan and note are generic words, so a fuller theme does not match c61 or c44 either");
});

test("a true owner repeat still counts: the owner's c47 and c32 repeats reopen them", () => {
  const state = ledger();
  const c47 = applyCorrection(state, parseCorrectionCall({ words: "look, be fucking aggressive. it's ok to break things. just make it work. NEVER wait for something, " +
    "or ask for my permission to push to Github etc.", rule: "The VP of CI acts aggressively on CI speed: it pushes ci/ refs and its own fixes to GitHub without waiting " +
    "for another thread's go or slot and without asking the owner, and accepts breakage to fix forward. Only production (main, promote) still needs the owner's go.",
    theme: "invented waiting rule overly", enforcedBy: "brief", ref: "VP of CI: held ci/ pushes released at once" }), CI, "2026-10-12T14:12:31.885Z");
  assert.deepEqual([c47.kind, c47.entry.id, c47.entry.status], ["repeat", "c47", "reopened"]);
  const c32 = applyCorrection(state, parseCorrectionCall({ words: "이름 이딴식으로 짓지 말고, \n\ngit rules are enforced, \nci works and isn't annoying\n\n이런식으로",
    rule: "Duty names state the outcome they keep true, in plain lowercase words (like 'git rules are enforced', 'ci works and isn't annoying'), never a label like " +
    "'CI guarantees' or 'Repo rules'.", theme: "duty names outcome plain words", enforcedBy: "brief", ref: "pending realtime layer brief change" }), CI, "2026-10-10T07:13:07.430Z");
  assert.deepEqual([c32.kind, c32.entry.id, c32.entry.status], ["repeat", "c32", "reopened"]);
});

test("notRepeatOf: the chat files a new rule in the same call, and a retry takes back the false repeat the old matcher put on c61", () => {
  const state = ledger();
  const words = "NEVER wait for something";
  const call = { words, rule: "Never wait on another thread's go before acting; act directly and stop waiting.", theme: "invented waiting rule overly", enforcedBy: "brief", ref: "x" };
  const repeat = applyCorrection(ledger(), parseCorrectionCall(call), CI, AT);
  assert.match(correctionResult(repeat), /If the owner gave a different rule, call correction_add again with notRepeatOf "c47", which takes this repeat back\.$/);
  const added = applyCorrection(state, parseCorrectionCall({ ...call, notRepeatOf: "c47" }), CI, AT);
  assert.deepEqual([added.kind, added.entry.id, byId(state, "c47").repeats.length], ["added", "c62", 0]);
  const live = ledger();
  const c61 = byId(live, "c61");
  c61.repeats.push({ at: AT, chat: OPS, words: SCRATCHPAD.words });
  c61.status = "reopened";
  assert.equal(applyCorrection(structuredClone(live), parseCorrectionCall(SCRATCHPAD), OPS, AT).kind, "known", "without notRepeatOf the words already sit on c61");
  const retry = applyCorrection(live, parseCorrectionCall({ ...SCRATCHPAD, notRepeatOf: ["c61"] }), OPS, "2026-10-15T09:00:00.000Z");
  assert.deepEqual([retry.kind, retry.entry.id], ["added", "c62"]);
  assert.deepEqual([c61.status, c61.repeats], ["active", []], "the false repeat is gone and c61 is active again");
  assert.throws(() => parseCorrectionCall({ ...SCRATCHPAD, notRepeatOf: "61" }), /notRepeatOf is a correction id like c3, not 61/);
});

test("mergeInto: a rule filed as new folds into the earlier one as a repeat and leaves the ledger", () => {
  const state = ledger();
  applyCorrection(state, parseCorrectionCall(SCRATCHPAD), OPS, AT);
  const merged = applyCorrection(state, parseCorrectionCall({ id: "c62", mergeInto: "c61" }), OPS, "2026-10-15T09:00:00.000Z");
  assert.deepEqual([merged.kind, merged.entry.id, merged.entry.status], ["repeat", "c61", "reopened"]);
  assert.deepEqual(byId(state, "c61").repeats, [{ at: AT, chat: OPS, words: SCRATCHPAD.words }]);
  assert.deepEqual(state.corrections.map(entry => entry.id), ["c32", "c44", "c47", "c61"]);
  assert.throws(() => applyCorrection(state, parseCorrectionCall({ id: "c61", mergeInto: "c61" }), OPS, AT), /No other correction c61 to merge c61 into/);
  assert.throws(() => applyCorrection(state, parseCorrectionCall({ id: "c62", mergeInto: "c61" }), OPS, AT), /No correction c62/);
});
