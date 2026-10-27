// 10-24 21:29Z: on a wake from its job "mac heavy checks on box", AI harness sent the p954 done (Agent code checks on the Mac run on
// us-metal02) while its goal p700 read 1 of 0 skills and tools to fix, and the owner never asked for p954. d11 labelled it an unasked result
// (c117). p954 has no duty, so the duty fix check let it out on the first call. A done for any step under an open goal that misses its
// target is now refused once, the very same text again goes out, and his own turn is never held.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openGoalDone, tellOwner, tellTurn } from "../src/chat-guard.ts";
import type { AssistantMessage, PlanItem, ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-24T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const job = (text: string, clock: string): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from child:mac heavy checks on box]\n\n${text}`, timestamp: at(clock) });
const said = (text: string, clock: string): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at(clock) }) as unknown as ThreadMessage;
const tell = (id: string, args: Record<string, unknown>, clock: string): AssistantMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: args }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as AssistantMessage;
const result = (id: string, text: string, clock: string): ThreadMessage => ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text }], isError: true, timestamp: at(clock) });

const step = (id: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text: `step ${id}`, status: "done", children: [], ...extra });
const goal = (id: string, current: number | undefined, target: number, children: PlanItem[], status: PlanItem["status"] = "todo"): PlanItem =>
  ({ id, text: `goal ${id}`, status, children, target: { metric: "skills and tools to fix on us-metal02", target, unit: "to fix", direction: "down", ...(current === undefined ? {} : { current }) } });
const plan: PlanItem[] = [goal("p700", 1, 0, [step("p954"), step("p960", { duty: "checkin/goal_gaps" })]), goal("p900", 0, 0, [step("p933")])];
const history = [owner("why is my mac swapping", "12:00:00"), said("The job mac heavy checks on box has it.", "12:01:00"), job("The M1 Air proof passed, p954 is done.", "21:29:00")];
const done = { text: "Agent code checks on your Mac now run on us-metal02, so the Mac's memory stays near zero for them (p954).", why: "done", about: "p954 heavy checks off the Mac" };

test("a done for a step under an open goal that misses its target is refused once on a turn the owner did not start, with no duty on the step", () => {
  const turn = { ...tellTurn(history), plan };
  assert.equal(turn.owner, false);
  const refused = tellOwner(done, turn, at("21:29:53"), () => true);
  assert.equal(refused.kind, "refused");
  assert.match(refused.text, /p954 is a step under goal p700, which reads 1 of 0/);
  const again = { ...tellTurn([...history, tell("a1", done, "21:29:53"), result("a1", refused.text, "21:29:54")]), plan };
  assert.equal(tellOwner(done, again, at("21:30:05"), () => true).kind, "sent", "the very same text again goes out");
  assert.equal(tellOwner(done, { ...turn, owner: true }, at("21:29:53"), () => true).kind, "sent", "his own turn is never held");
  assert.equal(tellOwner(done, tellTurn(history), at("21:29:53"), () => true).kind, "sent", "no board read holds nothing");
});

test("a done goes out when its goal is met, closed or unmeasured, its step is a check-in goal gap, or it names the goal too", () => {
  const turn = { ...tellTurn(history), plan };
  const send = (text: string) => tellOwner({ text, why: "done", about: "heavy checks" }, turn, at("21:29:53"), () => true).kind;
  assert.equal(send("The wiki links open the right page now (p933)."), "sent", "p900 reads 0 of 0, so the result is in");
  assert.equal(send("The goal gap step p960 is done."), "sent", "a check-in's goal gap step works toward his goal");
  assert.equal(send("p954 is done and p700 has nothing left to fix."), "sent", "it also names the goal");
  assert.equal(openGoalDone("p954 done", [{ ...plan[0]!, status: "done" }]), undefined, "a closed goal");
  assert.equal(openGoalDone("p954 done", [goal("p700", undefined, 0, [step("p954")])]), undefined, "an unmeasured goal");
  assert.equal(openGoalDone("p954 done", plan)?.goal.id, "p700");
});
