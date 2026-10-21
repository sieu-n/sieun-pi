// 10-21 on us-metal02 under Prime s3int.1-test: every call after a session's second stacked "[harness-digest update]" past its correction checkpoint read only 575 to 11,950 cached tokens and rewrote the rest (6 of 6 such calls under 60 min, 1.49M cache tokens, ~/work/d5-digest-append/cache-causes.md), because deliverCorrections counted only the newest digest while Prime sends the whole stack.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "prime-agent";
import { CORRECTION_CHECKPOINT, deliverCorrections } from "../src/correction-delivery.ts";

const at = (n: number) => `2026-10-21T15:${String(n).padStart(2, "0")}:00.000Z`;
const user = (id: string, n: number): SessionEntry => ({ type: "message", id, parentId: null, timestamp: at(n), message: { role: "user", content: [{ type: "text", text: id }], timestamp: n } }) as SessionEntry;
const reply = (id: string, n: number): SessionEntry => ({ type: "message", id, parentId: null, timestamp: at(n), message: { role: "assistant", content: [{ type: "text", text: id }], stopReason: "stop", timestamp: n } }) as unknown as SessionEntry;
const digest = (id: string, n: number, stacked: boolean): SessionEntry => ({ type: "custom_message", id, parentId: null, timestamp: at(n), customType: "harness_digest", content: stacked ? "[harness-digest update]" : "[harness-digest]", display: false, details: stacked ? { stacked: true } : {} }) as unknown as SessionEntry;
const sent = (entry: SessionEntry): AgentMessage => entry.type === "message" ? entry.message : { role: "custom", customType: "harness_digest", content: (entry as { content: string }).content, display: false, timestamp: 0 } as unknown as AgentMessage;
const isBlock = (message: AgentMessage) => message.role === "user" && JSON.stringify(message.content).includes("[corrections]");
const afterFirstPrompt = (messages: AgentMessage[]) => JSON.stringify(messages[messages.findIndex(isBlock) - 1]).includes('"text":"u1"');

/** Prime's context: every message, and of the digests the newest one with the stacked updates back to the one that replaced its predecessors. */
function call(branch: SessionEntry[]): AgentMessage[] {
  const digests = branch.filter(entry => entry.type === "custom_message");
  const base = digests.findLastIndex(entry => (entry as { details: { stacked?: boolean } }).details.stacked !== true);
  const kept = new Set(digests.slice(base).map(entry => entry.id));
  const context = branch.filter(entry => entry.type === "message" || kept.has(entry.id)).map(sent);
  return deliverCorrections({ messages: context, branch, ledger: null, job: true, brief: new Set(), append: data => branch.push({ type: "custom", id: `ck${branch.length}`, parentId: null, timestamp: at(99), customType: CORRECTION_CHECKPOINT, data } as unknown as SessionEntry) });
}

test("the corrections block stays after the first prompt while stacked digest updates pile up after it", () => {
  const branch: SessionEntry[] = [digest("d0", 0, false), user("u1", 1)];
  assert.ok(afterFirstPrompt(call(branch)), "first call");
  branch.push(reply("a1", 2), digest("d1", 3, true), user("u2", 4));
  assert.ok(afterFirstPrompt(call(branch)), "one stacked update");
  branch.push(reply("a2", 5), digest("d2", 6, true), user("u3", 7));
  assert.ok(afterFirstPrompt(call(branch)), "two stacked updates");
  branch.push(reply("a3", 8), digest("d3", 9, false), user("u4", 10));
  assert.ok(afterFirstPrompt(call(branch)), "a replacing digest after the stack");
});
