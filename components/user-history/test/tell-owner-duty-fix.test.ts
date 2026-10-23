// 10-23: two chats reported a done fix step their own duty run started while the owner's goal over it still missed its target, the unindexed
// blog pages cause (p90, d2, at 13:53Z) and the short-message clean test (p910, d10, at 17:40Z), and d11 labelled both progress on a goal
// still going (c117). Such a done is refused once, the very same text again goes out, and his own turn is never held.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dutyFixDone, tellOwner, tellTurn } from "../src/chat-guard.ts";
import type { AssistantMessage, PlanItem, ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-23T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const job = (text: string, clock: string): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from sibling:d10 dry replies check]\n\n${text}`, timestamp: at(clock) });
const said = (text: string, clock: string): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at(clock) }) as unknown as ThreadMessage;
const tell = (id: string, args: Record<string, unknown>, clock: string): AssistantMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: args }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as AssistantMessage;
const result = (id: string, text: string, clock: string): ThreadMessage => ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text }], isError: true, timestamp: at(clock) });

const step = (id: string, duty?: string): PlanItem => ({ id, text: `step ${id}`, status: "done", children: [], ...(duty ? { duty } : {}) });
const goal = (id: string, current: number, target: number, children: PlanItem[], status: PlanItem["status"] = "doing"): PlanItem =>
  ({ id, text: `goal ${id}`, status, target: { metric: "duties green", target, unit: "%", current, direction: "up" }, children });
const plan: PlanItem[] = [goal("p706", 59.6, 100, [step("p910", "d10/repeat_corrections_7d"), step("p896", "checkin/goal_gaps"), step("p904")]),
  goal("p1", 8, 8, [step("p305", "d6/repeated_design_notes_24h")]), goal("p56", 141.7, 10000, [step("p90", "d2/new_unindexed_3d")])];
const history = [owner("make the chats text me short", "05:00:00"), said("The job d10 dry replies check has it.", "05:01:00"),
  job("Clean room run 5 passed every line.", "17:39:00")];
const done = { text: "The short-message check you asked for passed its clean test, with a fresh chat answering in about one sentence each time (p910).",
  why: "done", about: "short owner messages, p910" };

test("a done for a duty run's fix step under a goal that misses its target is refused once on a turn the owner did not start", () => {
  const turn = { ...tellTurn(history), plan };
  assert.equal(turn.owner, false);
  const refused = tellOwner(done, turn, at("17:40:00"), () => true);
  assert.equal(refused.kind, "refused");
  assert.match(refused.text, /reports work still going, p910 is a fix for duty d10\/repeat_corrections_7d while its goal p706 reads 59.6 of 100/);
  const again = { ...tellTurn([...history, tell("a1", done, "17:40:00"), result("a1", refused.text, "17:40:01")]), plan };
  assert.equal(tellOwner(done, again, at("17:40:10"), () => true).kind, "sent", "the very same text again goes out");
  assert.equal(tellOwner(done, { ...turn, owner: true }, at("17:40:00"), () => true).kind, "sent", "his own turn is never held");
  assert.equal(tellOwner(done, tellTurn(history), at("17:40:00"), () => true).kind, "sent", "no board read holds nothing");
});

test("a done goes out when its goal is met, it names a goal or a step no duty run started, or it answers his message", () => {
  const turn = { ...tellTurn(history), plan };
  const send = (text: string, about = "duty fix") => tellOwner({ text, why: "done", about }, turn, at("17:40:00"), () => true).kind;
  assert.equal(send("None of your design notes count as repeated anymore (p305)."), "sent", "p1 reads 8 of 8, so the result is in");
  assert.equal(send("The goal gap step p896 is done."), "sent", "a check-in's goal gap step works toward his goal");
  assert.equal(send("The plan cleanup p904 is done."), "sent", "a step no duty run started");
  assert.equal(send("p910 is done and p706 reads green now."), "sent", "it also names the goal");
  assert.equal(tellOwner({ ...done, why: "answer" }, turn, at("17:40:00"), () => true).kind, "sent", "an answer is not a done");
  assert.deepEqual(dutyFixDone("cause found (p90)", plan)?.goal.id, "p56");
  assert.equal(dutyFixDone("cause found (p90)", [{ ...plan[2]!, status: "done" }]), undefined, "a closed goal");
  assert.equal(dutyFixDone("cause found (p90)", [{ ...plan[2]!, target: { metric: "visits", target: 10000, unit: "visits" } }]), undefined, "an unmeasured goal");
});
