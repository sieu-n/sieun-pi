import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "prime-agent";
import { collectHistory } from "../src/history.ts";
import { assistant, entries, markedText, text, user } from "./fixtures.ts";

const reply = (value: string) => assistant([markedText(value)]);

test("empty ancestry stays empty", () => {
  assert.deepEqual(collectHistory([]), { groups: [], orphanFinalCount: 0 });
});

test("preserves questions and every final in ancestry order without commentary", () => {
  const history = collectHistory(entries([
    user("first"), assistant([markedText("progress", "commentary"), markedText("a"), markedText("b")]),
    reply("later"), user("last"), reply("end"),
  ]));
  assert.deepEqual(history.groups, [
    { questions: [{ parts: [{ kind: "text", text: "first" }] }], finals: [{ texts: ["a", "b"] }, { texts: ["later"] }] },
    { questions: [{ parts: [{ kind: "text", text: "last" }] }], finals: [{ texts: ["end"] }] },
  ]);
});

test("validates API, signature version, id and phase at the boundary", () => {
  const signatures = ["not JSON", "null", "[]", '"final_answer"', '{"v":2,"id":"x","phase":"final_answer"}',
    '{"v":1,"phase":"final_answer"}', '{"v":1,"id":3,"phase":"final_answer"}',
    '{"v":1,"id":"x","phase":"unknown"}'];
  for (const textSignature of signatures) {
    const history = collectHistory(entries([user("question"), assistant([{ type: "text", text: "unmarked", textSignature }])]));
    assert.deepEqual(history.groups[0]?.finals, []);
    assert.deepEqual(history.groups[0]?.lastUnmarkedReply, { texts: ["unmarked"] });
  }
  for (const api of ["anthropic-messages", "openai-completions", "unknown"]) {
    const history = collectHistory(entries([user("question"), assistant([markedText("unknown")], { api })]));
    assert.equal(history.groups[0]?.finals.length, 0);
  }
  for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses"]) {
    assert.equal(collectHistory(entries([user("q"), assistant([markedText("ok")], { api })])).groups[0]?.finals.length, 1);
  }
});

test("never promotes incomplete or tool-bearing responses", () => {
  for (const stopReason of ["error", "aborted", "length", "toolUse"] satisfies Array<ReturnType<typeof assistant>["stopReason"]>) {
    const history = collectHistory(entries([user("q"), assistant([markedText("partial"), text("unsigned")], { stopReason })]));
    assert.deepEqual(history.groups[0], { questions: [{ parts: [{ kind: "text", text: "q" }] }], finals: [] });
  }
  const history = collectHistory(entries([user("q"), assistant([markedText("not final"), { type: "toolCall", id: "tool", name: "forbidden", arguments: {} }])]));
  assert.equal(history.groups[0]?.finals.length, 0);
  assert.equal(history.groups[0]?.lastUnmarkedReply, undefined);
});

test("unmarked fallback excludes commentary and never replaces a marked final", () => {
  const history = collectHistory(entries([
    user("q"), assistant([text("old")]), assistant([text("last"), markedText("hidden", "commentary")]),
    user("q2"), reply("keep"), assistant([text("new unsigned")]), assistant([markedText("failed")], { stopReason: "error" }),
  ]));
  assert.deepEqual(history.groups[0]?.lastUnmarkedReply, { texts: ["last"] });
  assert.deepEqual(history.groups[1]?.finals, [{ texts: ["keep"] }]);
  assert.equal(history.groups[1]?.lastUnmarkedReply, undefined);
});

test("compaction preserves groups and excludes inactive branches through native SessionManager", () => {
  const manager = SessionManager.inMemory("/tmp/synthetic-history");
  const first = manager.appendMessage(user("pre-compaction"));
  manager.appendMessage(user("adjacent"));
  manager.appendCompaction("DO NOT RENDER SUMMARY", first, 999);
  manager.appendMessage(reply("after compaction"));
  const branchPoint = manager.getLeafId();
  assert.ok(branchPoint);
  manager.appendMessage(user("inactive question"));
  manager.appendMessage(reply("inactive final"));
  manager.branch(branchPoint);
  manager.appendMessage(user("active question"));
  const before = JSON.stringify(manager.getEntries());
  const leaf = manager.getLeafId();
  const snapshot = collectHistory(manager.getBranch());
  assert.equal(snapshot.groups.length, 2);
  assert.equal(snapshot.groups[0]?.questions.length, 2);
  assert.deepEqual(snapshot.groups[0]?.finals, [{ texts: ["after compaction"] }]);
  assert.match(JSON.stringify(snapshot), /pre-compaction/);
  assert.doesNotMatch(JSON.stringify(snapshot), /SUMMARY|inactive/);
  assert.equal(JSON.stringify(manager.getEntries()), before);
  assert.equal(manager.getLeafId(), leaf);
});

test("assistant, custom, and tool messages split adjacent questions", () => {
  const manager = SessionManager.inMemory("/tmp/synthetic-history");
  manager.appendMessage(user("a"));
  manager.appendCustomMessageEntry("agent_message", "FORBIDDEN AGENT TEXT", true);
  manager.appendMessage(user("b"));
  manager.appendMessage(assistant([markedText("progress", "commentary")]));
  manager.appendMessage(user("c"));
  manager.appendMessage({ role: "toolResult", toolCallId: "tool", toolName: "synthetic", content: [text("FORBIDDEN TOOL")], isError: false, timestamp: 1 });
  manager.appendMessage(user("d"));
  assert.equal(collectHistory(manager.getBranch()).groups.length, 4);
  assert.doesNotMatch(JSON.stringify(collectHistory(manager.getBranch())), /FORBIDDEN|progress/);
});

test("preserves ordered skill, text, image, empty and long message parts", () => {
  const skill = '<skill name="example" location="/synthetic/SKILL.md">\ninjected instructions\n</skill>\n\narguments';
  const long = "long line\n".repeat(20000);
  const history = collectHistory(entries([user([text("before"), { type: "image", mimeType: "image/png", data: "PRIVATE IMAGE BYTES" }, text(skill), text("after")]), user(""), user(long)]));
  assert.deepEqual(history.groups[0]?.questions[0]?.parts, [
    { kind: "text", text: "before" }, { kind: "attachment", label: "Saved image (image/png). Image not displayed." },
    { kind: "skill", name: "example", instructions: "injected instructions", arguments: "arguments" }, { kind: "text", text: "after" },
  ]);
  assert.deepEqual(history.groups[0]?.questions[1]?.parts, [{ kind: "text", text: "" }]);
  assert.equal(history.groups[0]?.questions[2]?.parts[0]?.kind, "text");
  assert.ok(JSON.stringify(history).includes(long.replaceAll("\n", "\\n")));
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE IMAGE BYTES|synthetic\/SKILL/);
});

test("orphan finals are counted without invented questions", () => {
  const history = collectHistory(entries([reply("orphan"), user("no reply")]));
  assert.equal(history.orphanFinalCount, 1);
  assert.equal(history.groups.length, 1);
  assert.deepEqual(history.groups[0]?.finals, []);
});
