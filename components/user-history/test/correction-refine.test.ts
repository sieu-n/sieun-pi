import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ledger } from "../src/chat-corrections.ts";
import { CORRECTION_ASK, correctionStep, readsAsCorrection } from "../src/correction-refine.ts";
import { serverNote } from "../src/shared/chat-feed.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const CHAT = "01a141c1-0000-7000-8000-000000000001";
const HOUR = 60 * 60_000;
const T0 = Date.parse("2026-10-16T00:00:00Z");
const owner = (text: string, at: number): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at });
const notice = (head: string, at: number): ThreadMessage => ({ role: "custom", customType: "refinement_notice", content: `${head}\n\nSaved a prompt note.`, timestamp: at });
const ledger = (at: number, chat = CHAT, repeatAt?: number): Ledger => ({ corrections: [{ id: "c87", at: new Date(at).toISOString(), chat: { id: chat, name: "instagram gaps" },
  words: "stop using bold in your replies", rule: "Replies use no bold.", enforcedBy: "brief", ref: "pending", status: "active", theme: ["bold", "replies"],
  repeats: repeatAt === undefined ? [] : [{ at: new Date(repeatAt).toISOString(), chat: { id: CHAT, name: "instagram gaps" }, words: "no bold!!" }] }] });
const BOLD = "stop using bold in your replies, it's hard to read";

test("a correction the chat recorded after the owner's message gets one global /refine aimed at it", () => {
  const step = correctionStep(CHAT, ledger(T0 + 60_000), [owner(BOLD, T0)], T0 + 120_000, HOUR);
  assert.equal(step?.kind, "refine");
  assert.equal(step?.at, T0 + 60_000);
  assert.match(step!.message, /^\/refine --global The owner corrected an agent in this chat: c87 "stop using bold in your replies" \(rule: Replies use no bold\.\)\. /);
  assert.ok(!step!.message.includes("\n"));
});

test("a repeat recorded in this chat refines too, and an entry from another chat does not", () => {
  assert.equal(correctionStep(CHAT, ledger(T0 - 5 * HOUR, "other", T0 + 60_000), [owner("no bold!!", T0)], T0 + 120_000, HOUR)?.kind, "refine");
  const other = correctionStep(CHAT, ledger(T0 + 60_000, "other"), [owner("thanks, looks good", T0)], T0 + 120_000, HOUR);
  assert.equal(other, null);
});

test("a refinement the chat ran itself after the record ends it, and an auto-refinement does not", () => {
  const recorded = ledger(T0 + 60_000);
  assert.equal(correctionStep(CHAT, recorded, [owner(BOLD, T0), notice("[self-refinement]", T0 + 90_000)], T0 + 120_000, HOUR), null);
  assert.equal(correctionStep(CHAT, recorded, [owner(BOLD, T0), notice("[auto-refinement]", T0 + 90_000)], T0 + 120_000, HOUR)?.kind, "refine");
});

test("an owner message that reads as a correction with nothing recorded gets the one-line check, an ordinary one gets nothing", () => {
  const step = correctionStep(CHAT, { corrections: [] }, [owner(BOLD, T0)], T0 + 60_000, HOUR);
  assert.deepEqual(step, { kind: "ask", at: T0, message: CORRECTION_ASK });
  assert.equal(CORRECTION_ASK.split("\n").length, 1);
  assert.equal(serverNote(CORRECTION_ASK), "corrections");
  assert.equal(correctionStep(CHAT, { corrections: [] }, [owner("research the top 10 gaps and keep a page updated", T0)], T0 + 60_000, HOUR), null);
});

test("the check's own line is no owner message, so the scan keeps reading the owner's", () => {
  const step = correctionStep(CHAT, { corrections: [] }, [owner(BOLD, T0), owner(CORRECTION_ASK, T0 + 30_000)], T0 + 60_000, HOUR);
  assert.equal(step?.at, T0);
});

test("anything older than the age limit is left alone", () => {
  assert.equal(correctionStep(CHAT, ledger(T0 + 60_000), [owner(BOLD, T0)], T0 + 2 * HOUR, HOUR), null);
  assert.equal(correctionStep(CHAT, { corrections: [] }, [owner(BOLD, T0)], T0 + 2 * HOUR, HOUR), null);
});

test("the correction words match the owner's corrections in his style and pass plain asks", () => {
  for (const text of ["I SAID SETUP DUTY", "stop making up these bullshit rules on waiting", "nononononono", "unslop, you are talking so much slop", "씨발 잘좀해봐",
    "never auto merge anything without my approval", "why did you send that email", "don't use bold in replies"]) assert.ok(readsAsCorrection(text), text);
  for (const text of ["research which of our instagram index gaps matter most", "what should i review?", "looks good, ship it"]) assert.ok(!readsAsCorrection(text), text);
});
