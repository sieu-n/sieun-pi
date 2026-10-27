// pi-harness (packages/pi-harness) keeps every harness_digest message in the live context and removes refinement_outcome messages in
// its context hook, so deliverCorrections counts the messages that way under digests: "pi-harness" and the block stays after the first prompt.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "prime-agent";
import { CORRECTION_CHECKPOINT, deliverCorrections } from "../src/correction-delivery.ts";

const at = (n: number) => `2026-10-27T08:${String(n).padStart(2, "0")}:00.000Z`;
const user = (id: string): SessionEntry => ({ type: "message", id, parentId: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: id }], timestamp: 1 } }) as SessionEntry;
const reply = (id: string): SessionEntry => ({ type: "message", id, parentId: null, timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: id }], stopReason: "stop", timestamp: 2 } }) as unknown as SessionEntry;
const custom = (id: string, customType: string, details: object = {}): SessionEntry =>
  ({ type: "custom_message", id, parentId: null, timestamp: at(3), customType, content: id, display: false, details }) as unknown as SessionEntry;
const sent = (entry: SessionEntry): AgentMessage => entry.type === "message" ? entry.message
  : { role: "custom", customType: (entry as { customType: string }).customType, content: (entry as { content: string }).content, display: false, timestamp: 0 } as unknown as AgentMessage;
const isBlock = (message: AgentMessage) => message.role === "user" && JSON.stringify(message.content).includes("[corrections]");
const before = (messages: AgentMessage[]) => JSON.stringify(messages[messages.findIndex(isBlock) - 1]);

/** pi-harness's context: every message and digest on the branch, without refinement outcomes. */
function call(branch: SessionEntry[], digests?: "prime" | "pi-harness"): AgentMessage[] {
  const context = branch.filter(entry => entry.type === "message" || (entry.type === "custom_message" && (entry as { customType: string }).customType !== "refinement_outcome")).map(sent);
  return deliverCorrections({ messages: context, branch, ledger: null, job: true, brief: new Set(), ...(digests ? { digests } : {}),
    append: data => branch.push({ type: "custom", id: `ck${branch.length}`, parentId: null, timestamp: at(9), customType: CORRECTION_CHECKPOINT, data } as unknown as SessionEntry) });
}

test("under pi-harness the block stays after the first prompt while full digests and outcomes pile up", () => {
  const branch: SessionEntry[] = [custom("d0", "harness_digest"), user("u1")];
  assert.match(before(call(branch, "pi-harness")), /"text":"u1"/);
  branch.push(reply("a1"), custom("o1", "refinement_outcome"), custom("d1", "harness_digest"), user("u2"));
  assert.match(before(call(branch, "pi-harness")), /"text":"u1"/);
  branch.push(reply("a2"), custom("d2", "harness_digest", { stacked: true }), user("u3"));
  assert.match(before(call(branch, "pi-harness")), /"text":"u1"/);
});

test("Prime's rule on the same branch counts only the newest full digest, which is why pi-host needs its own", () => {
  const branch: SessionEntry[] = [custom("d0", "harness_digest"), user("u1")];
  call(branch, "prime");
  branch.push(reply("a1"), custom("d1", "harness_digest"), user("u2"), reply("a2"), custom("d2", "harness_digest"), user("u3"));
  assert.match(before(call(branch, "pi-harness")), /"text":"u1"/);
  assert.doesNotMatch(before(call(branch, "prime")), /"text":"u1"/);
});
