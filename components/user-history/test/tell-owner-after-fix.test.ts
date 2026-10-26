// 10-25: two noise lines reached the owner on turns he did not start with every older tell_owner check in place (c117). At 10:35:34Z a chat
// sent "the small prod Vent update on t15 isn't needed" 3 s after it checked its own t15 with no answer from him, and at 06:49:24Z Crawler VP
// sent the disk finding behind its new t68 as a decision that asked nothing, 16 s before the t68 ask itself. Each is now refused once, the
// very same text again goes out, and his own turn is never held.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tellOwner, tellTurn } from "../src/chat-guard.ts";
import type { AssistantMessage, ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-25T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const job = (text: string, clock: string): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from sibling:vent box tokens]\n\n${text}`, timestamp: at(clock) });
const said = (text: string, clock: string): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at(clock) }) as unknown as ThreadMessage;
const call = (id: string, name: string, args: Record<string, unknown>, clock: string): AssistantMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as AssistantMessage;
const result = (id: string, name: string, text: string, clock: string): ThreadMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: at(clock) });

const ask = "The Vercel and Railway monitoring panels froze at 11:08 KST. Can I ship the small prod Vent update now to fix them?";
const added = [owner("take the last provider keys off the prod server", "01:00:00"), call("b1", "chat_board", { ops: [{ op: "todo_add", text: ask, choices: ["Yes", "No"] }] }, "01:00:10"),
  result("b1", "chat_board", "Added a todo t15 \"The Vercel and Railway monitoring panels froze at 11:08 KST. Can I ship the sma…\"\nBoard rev 1400: 3 open steps, 1 open todos.", "01:00:11"),
  said("t15 asks him.", "01:00:20")];
const checked = [job("Release 21 fixed the exporter, and the two box tokens are gone.", "10:35:00"),
  call("b2", "chat_board", { ops: [{ op: "todo_update", id: "t15", done: true, note: "Not needed: release 21 fixed it." }] }, "10:35:31"),
  result("b2", "chat_board", "Checked \"The Vercel and Railway monitoring panels froze at 11:08 KST. Can I ship the sma…\"\nBoard rev 1466: 3 open steps, 0 open todos.", "10:35:32")];
const done = { text: "Release 21 fixed the frozen Vercel and Railway panels, so the small prod Vent update on t15 isn't needed. The 2 keys are gone from the prod server.",
  why: "done", about: "t15 frozen panels and the last 2 prod keys" };

test("a text that names a todo the chat took back with no answer from him is refused once, and the very same text again goes out", () => {
  const turn = tellTurn([...added, ...checked]);
  assert.equal(turn.owner, false);
  const refused = tellOwner(done, turn, at("10:35:34"), () => true);
  assert.equal(refused.kind, "refused");
  assert.match(refused.text, /takes back your own ask \(t15 "The Vercel and Railway/);
  const again = tellTurn([...added, ...checked, call("s1", "tell_owner", done, "10:35:34"), result("s1", "tell_owner", refused.text, "10:35:35")]);
  assert.equal(tellOwner(done, again, at("10:35:40"), () => true).kind, "sent", "the very same text again goes out");
  assert.equal(tellOwner(done, { ...turn, owner: true }, at("10:35:34"), () => true).kind, "sent", "his own turn is never held");
  const answered = tellTurn([...added, owner("[board] The owner answered \"The Vercel and Railway monitoring panels froze at 11:08 KST. Can I ship the sma…\": Yes", "09:00:00"),
    said("Shipping it.", "09:00:10"), ...checked]);
  assert.equal(tellOwner(done, answered, at("10:35:34"), () => true).kind, "sent", "a todo he answered was no ask taken back");
  assert.equal(tellOwner(done, turn, at("10:35:34") + 24 * 3_600_000 + 1, () => true).kind, "sent", "a todo taken back over a day ago is old news");
});

test("a decision with no question, pick or todo in it is refused once, and one that asks him goes out", () => {
  const turn = tellTurn([owner("keep the crawl disks from filling", "01:00:00"), said("A job reads the runway.", "01:00:10"),
    job("The decision page is up, version 2.", "06:49:10")]);
  const finding = { text: "us-metal01's fast CI disk fills OpenSearch's read-only line about 06:00 KST 10-29, and moving OpenSearch to the root disk buys about 2 weeks. " +
    "wiki:projects/multi-platform-crawl-scale/metal01-disk-runway.html", why: "decision", about: "us-metal01 disk runway, new disk todo" };
  const refused = tellOwner(finding, turn, at("06:49:24"), () => true);
  assert.equal(refused.kind, "refused");
  assert.match(refused.text, /^Not sent, this decision asks him nothing/);
  assert.equal(tellOwner(finding, { ...turn, resent: new Set([finding.text]) }, at("06:49:40"), () => true).kind, "sent", "the very same text again goes out");
  assert.equal(tellOwner(finding, { ...turn, owner: true }, at("06:49:24"), () => true).kind, "sent", "his own turn is never held");
  for (const text of ["Which disk plan do you want (t68)? My pick is B, which also keeps only links for old Meta ad images.",
    "Instagram posts stored is stuck near 6% (p684), and at today's rate public accounts take about 70 days. Pick how much crawl room post history gets in t66.",
    "From 10-26, weekly re-reads take about two-thirds of census reads. I'd re-read private and small accounts every 14 days instead."])
    assert.equal(tellOwner({ text, why: "decision", about: "disk plan" }, turn, at("06:49:40"), () => true).kind, "sent", text);
  assert.equal(tellOwner({ ...finding, why: "done" }, turn, at("06:49:24"), () => true).kind, "sent", "only a decision is checked");
});

test("the refusal of a re-ask of an open todo says a reminder or a new date stays on For you and only a changed pick goes again", () => {
  // 10-25: at 03:51Z a chat resent the t15 ask with its cause added 4.7 s after this refusal, and at 10:57Z another sent "t34 is more urgent
  // now" 8.2 s after it; d11 labelled both noise. A code hold of such resends would also hold 8 needed corrections, so the refusal says it.
  const turn = { ...tellTurn([owner("keep the disks from filling", "01:00:00"), said("A job reads it.", "01:00:10"), job("CI disk holds 5 days", "10:57:00")]), asked: new Set(["t34"]) };
  const nudge = { text: "t34 is more urgent now, since us-metal01's CI disk will hold only about 5 days after tonight's cleanup.", why: "decision", about: "t34 disk growth choice" };
  const refused = tellOwner(nudge, turn, at("10:57:33"), () => true);
  assert.equal(refused.kind, "refused");
  assert.match(refused.text, /a re-ask of an open todo stays on For you/);
  assert.match(refused.text, /a new date or number, more or less urgency in t34/);
  assert.match(refused.text, /A new date or number on the same question is no correction/);
  assert.match(refused.text, /only when your pick or his choices change/);
  assert.equal(tellOwner(nudge, { ...turn, resent: new Set([nudge.text]) }, at("10:57:42"), () => true).kind, "sent", "the very same text again goes out");
});
