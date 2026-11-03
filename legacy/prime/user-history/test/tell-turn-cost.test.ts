// 11-03: tellTurn built the whole chat feed on each tell_owner call to learn whether the owner's last message was unanswered. On a
// 36,000-message chat that took 0.3 to 0.5 s of each call, and up to 2 s inside 6 to 8 s worker stalls. Only the messages from his last one
// on decide it, so the call now costs less than one feed build of its history.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tellTurn } from "../src/chat-guard.ts";
import { chatLines } from "../src/shared/chat-feed.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

let clock = Date.parse("2026-11-03T00:00:00Z");
const next = (): number => (clock += 1000);
const owner = (text: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: next() }) as ThreadMessage;
const job = (text: string): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from child:crawler]\n\n${text}`, timestamp: next() });
const said = (text: string, stopReason = "stop"): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: next() }) as unknown as ThreadMessage;
const call = (id: string, name: string, args: Record<string, unknown>): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "text", text: "Checking the board first." }, { type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: next() }) as unknown as ThreadMessage;
const result = (id: string, name: string, text: string, isError = false): ThreadMessage => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: next() });

const report = "The census run finished 4,210 pages. Two hosts timed out and the job retried them. You can read the numbers on the board. " +
  "The next run starts at the top of the hour, and t12 still waits on your answer.";
/**
 * Turns of each kind a chat has: an owner turn it answers, one it answers with tell_owner, one a refusal ends, and mostly wakes it closes with
 * notes, about the share of owner messages in a busy chat (535 of 36,000 messages in the job chat on 11-03).
 */
function turns(n: number): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  for (let index = 0; index < n; index++) {
    const id = `c${index}`;
    switch (index % 40) {
      case 1: messages.push(owner("is the census done?"), said("Yes, 4,210 pages.")); break;
      case 2: messages.push(owner("and the retries?"), call(id, "tell_owner", { text: "Both hosts came back." }), result(id, "tell_owner", "Sent."), said("Told him.")); break;
      case 3: messages.push(owner("ok"), call(id, "tell_owner", { text: "" }), result(id, "tell_owner", "nothing to tell: give text", true), said("x", "error")); break;
      default: messages.push(job(report), call(id, "ipython", { code: "board.open()" }), result(id, "ipython", "ok"), said(report)); break;
    }
  }
  return messages;
}

test("tellTurn reads the owner's last message as unanswered exactly when the whole feed does", () => {
  const messages = turns(80);
  for (let end = 1; end <= messages.length; end++) {
    const before = messages.slice(0, end);
    const lines = chatLines(before);
    const unanswered = lines.findLastIndex(line => line.kind === "user") > lines.findLastIndex(line => line.kind === "agent");
    const turn = tellTurn([...before, call("now", "tell_owner", { text: "Done." })]);
    assert.equal(turn.owner, unanswered || turn.byOwner, `prefix of ${end}`);
  }
});

test("tellTurn on a long chat costs less than half of one feed build of its history", () => {
  const history = [...turns(5000), owner("status?"), call("now", "tell_owner", { text: "All green." })];
  const best = (run: () => unknown): number => {
    let least = Infinity;
    for (let round = 0; round < 5; round++) { const start = performance.now(); run(); least = Math.min(least, performance.now() - start); }
    return least;
  };
  const feed = best(() => chatLines(history.slice(0, -1)));
  const spent = best(() => tellTurn(history));
  assert.ok(spent < feed / 2, `tellTurn took ${spent.toFixed(1)} ms against ${feed.toFixed(1)} ms for one feed build of its ${history.length} messages`);
});
