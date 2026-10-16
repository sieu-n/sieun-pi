import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ContextEvent, type SessionEntry } from "prime-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORRECTION_CHECKPOINT, deliverCorrections } from "../src/correction-delivery.ts";
import { applyCorrection, parseCorrectionCall, type Ledger } from "../src/chat-corrections.ts";

const owner = { id: "owner", name: "VP" };
const user = (text: string): Extract<ContextEvent["messages"][number], { role: "user" }> => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const entry = (id: string, message: ContextEvent["messages"][number], parentId: string | null = null): SessionEntry =>
  ({ type: "message", id, parentId, timestamp: "2026-10-09T10:00:00Z", message });
const text = (message: ContextEvent["messages"][number]): string =>
  message.role === "user" && Array.isArray(message.content) && message.content[0]?.type === "text" ? message.content[0].text : "";
const add = (ledger: Ledger, id: number) => applyCorrection(ledger,
  parseCorrectionCall({ words: `words ${id}`, theme: `unique${id} theme${id}`, rule: `Rule ${id}.`, enforcedBy: "brief", ref: "test" }), owner, `2026-10-09T10:0${id}:00Z`);

function session() {
  const branch: SessionEntry[] = [];
  let sequence = 0;
  const append = (data: unknown) => branch.push({ type: "custom", id: `checkpoint-${++sequence}`, parentId: branch.at(-1)?.id ?? null,
    timestamp: "2026-10-09T10:00:00Z", customType: CORRECTION_CHECKPOINT, data });
  const call = (messages: ContextEvent["messages"], ledger: Ledger | null, job = false) =>
    deliverCorrections({ messages, branch, ledger, job, brief: new Set(), append });
  return { branch, call };
}

test("the block goes in once: a later ledger change sends no update, and an old session's update checkpoint still replays in place", () => {
  const { branch, call } = session();
  const first = user("First owner message");
  branch.push(entry("first", first));
  const ledger: Ledger = { corrections: [] };
  add(ledger, 1);
  const before = call([first], ledger);
  assert.deepEqual(before.map(text), ["First owner message", text(before[1]!)]);
  assert.match(text(before[1]!), /- c1 Rule 1\./);
  add(ledger, 2);
  assert.deepEqual(call([first], ledger), before);
  applyCorrection(ledger, parseCorrectionCall({ id: "c1", status: "retired" }), owner, "");
  assert.deepEqual(call([first], ledger), before);
  assert.equal(branch.filter(item => item.type === "custom").length, 1);
  branch.push({ type: "custom", id: "old-update", parentId: branch.at(-1)!.id, timestamp: "2026-10-09T10:00:00Z", customType: CORRECTION_CHECKPOINT,
    data: { kind: "update", lines: [], text: "[corrections] Update to the owner's rules.", after: "first" } });
  const replayed = call([first], ledger);
  assert.deepEqual(replayed.slice(0, 2), before);
  assert.equal(text(replayed[2]!), "[corrections] Update to the owner's rules.");
});

test("a branch after a checkpoint inherits it; a branch before it gets a fresh snapshot", () => {
  const { branch, call } = session();
  const first = user("First");
  branch.push(entry("first", first));
  const ledger: Ledger = { corrections: [] };
  add(ledger, 1);
  call([first], ledger);
  const inherited = branch.slice();
  inherited.push(entry("later", user("Later"), inherited.at(-1)!.id));
  const follow = deliverCorrections({ messages: [first, user("Later")], branch: inherited, ledger, job: false, brief: new Set(), append() { throw Error("duplicate"); } });
  assert.deepEqual(follow.map(text).filter(line => line.startsWith("[corrections]")), [text(call([first], ledger)[1]!)]);
  const older = branch.slice(0, 1);
  let writes = 0;
  const fork = deliverCorrections({ messages: [first], branch: older, ledger, job: false, brief: new Set(), append() { writes++; } });
  assert.equal(writes, 1);
  assert.match(text(fork[1]!), /- c1 Rule 1\./);
});

test("compaction makes one new snapshot; older checkpoints are not replayed", () => {
  const { branch, call } = session();
  const first = user("Before compaction");
  branch.push(entry("first", first));
  const ledger: Ledger = { corrections: [] };
  add(ledger, 1);
  call([first], ledger);
  branch.push({ type: "compaction", id: "compacted", parentId: branch.at(-1)!.id, timestamp: "2026-10-09T10:00:00Z",
    summary: "Prior work", firstKeptEntryId: "missing", tokensBefore: 100 });
  const summary = user("Compacted summary");
  const snapshot = call([summary], ledger);
  assert.equal(snapshot.length, 2);
  assert.match(text(snapshot[1]!), /- c1 Rule 1\./);
  assert.deepEqual(call([summary], ledger), snapshot);
});

test("native SessionManager replays checkpoints at the same position after disk reopen, branch, and compaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "correction-native-"));
  try {
    const manager = SessionManager.create(dir, dir);
    const first = user("Original owner prompt");
    const firstId = manager.appendMessage(first);
    const ledger: Ledger = { corrections: [] };
    add(ledger, 1);
    const deliver = (current: SessionManager, rules: Ledger) => deliverCorrections({ messages: current.buildSessionContext().messages,
      branch: current.getBranch(), ledger: rules, job: false, brief: new Set(), append: data => { current.appendCustomEntry(CORRECTION_CHECKPOINT, data); } });
    const initial = deliver(manager, ledger);
    assert.deepEqual(initial.map(text), ["Original owner prompt", text(initial[1]!)]);
    manager.appendMessage(fauxAssistantMessage("First answer"));
    const file = manager.getSessionFile();
    assert.ok(file);
    const reopened = SessionManager.open(file, dir);
    const replay = deliver(reopened, ledger);
    assert.equal(replay.filter(item => text(item).startsWith("[corrections]")).length, 1);
    assert.deepEqual(replay.slice(0, initial.length), initial);
    const checkpointCount = () => reopened.getBranch().filter(item => item.type === "custom" && item.customType === CORRECTION_CHECKPOINT).length;
    assert.equal(checkpointCount(), 1);
    assert.deepEqual(deliver(reopened, ledger), replay);
    assert.equal(checkpointCount(), 1);
    add(ledger, 2);
    assert.deepEqual(deliver(reopened, ledger), replay, "a new rule is not sent into a running context");
    assert.equal(checkpointCount(), 1);
    reopened.branch(firstId);
    const forked = deliver(reopened, ledger);
    assert.equal(checkpointCount(), 1);
    assert.match(text(forked[1]!), /- c2 Rule 2\./);
    reopened.appendMessage(fauxAssistantMessage("Second answer"));
    reopened.appendCompaction("Conversation summary", "missing", 100);
    const compacted = deliver(reopened, ledger);
    assert.equal(compacted[0]?.role, "compactionSummary");
    assert.match(text(compacted[1]!), /- c2 Rule 2\./);
    assert.match(text(compacted[1]!), /- c1 Rule 1\./);
    assert.deepEqual(deliver(reopened, ledger), compacted);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a fresh job keeps the outside-action rule when the ledger cannot be read", () => {
  const { branch, call } = session();
  const first = user("Worker starts");
  branch.push(entry("first", first));
  const result = call([first], null, true);
  assert.match(text(result[1]!), /c37: nothing goes out without the owner's ok on a For you todo\./);
  assert.deepEqual(call([first], null, true), result);
});

test("native context drops an old harness digest without shifting a correction checkpoint", () => {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendCustomMessageEntry("harness_digest", "old digest", false);
  const ownerMessage = user("Owner message");
  manager.appendMessage(ownerMessage);
  const ledger: Ledger = { corrections: [] };
  add(ledger, 1);
  const call = () => deliverCorrections({ messages: manager.buildSessionContext().messages, branch: manager.getBranch(), ledger, job: false, brief: new Set(),
    append: data => { manager.appendCustomEntry(CORRECTION_CHECKPOINT, data); } });
  const first = call();
  assert.deepEqual(first.map(text), ["", "Owner message", text(first[2]!)]);
  manager.appendCustomMessageEntry("harness_digest", "new digest", false);
  const replaced = call();
  assert.deepEqual(replaced.map(text), ["Owner message", text(first[2]!), ""]);
  assert.equal(manager.getBranch().filter(item => item.type === "custom" && item.customType === CORRECTION_CHECKPOINT).length, 1);
});

test("native compaction with retained messages puts a fresh snapshot after the summary", () => {
  const manager = SessionManager.inMemory("/tmp");
  const id = manager.appendMessage(user("Retained owner prompt"));
  const ledger: Ledger = { corrections: [] };
  add(ledger, 1);
  const call = () => deliverCorrections({ messages: manager.buildSessionContext().messages, branch: manager.getBranch(), ledger, job: false, brief: new Set(),
    append: data => { manager.appendCustomEntry(CORRECTION_CHECKPOINT, data); } });
  call();
  manager.appendMessage(fauxAssistantMessage("Retained answer"));
  add(ledger, 2);
  manager.appendCompaction("The summary", id, 100);
  const messages = call();
  assert.equal(messages[0]?.role, "compactionSummary");
  assert.match(text(messages[1]!), /- c2 Rule 2\./);
  assert.equal(text(messages[2]!), "Retained owner prompt");
  assert.deepEqual(call(), messages);
});

test("a rule the brief names or landed code holds is left out, and later changes send nothing", () => {
  const branch: SessionEntry[] = [];
  const append = (data: unknown) => branch.push({ type: "custom", id: `checkpoint-${branch.length}`, parentId: branch.at(-1)?.id ?? null,
    timestamp: "2026-10-09T10:00:00Z", customType: CORRECTION_CHECKPOINT, data });
  const first = user("Owner prompt");
  branch.push(entry("first", first));
  const call = (ledger: Ledger) => deliverCorrections({ messages: [first], branch, ledger, job: false, brief: new Set(["c1"]), append });
  const ledger: Ledger = { corrections: [] };
  const landed = (id: number) => applyCorrection(ledger, parseCorrectionCall({ words: `words ${id}`, theme: `unique${id} theme${id}`, rule: `Rule ${id}.`,
    enforcedBy: "code", ref: "abc1234" }), owner, `2026-10-09T10:0${id}:00Z`);
  add(ledger, 1);
  landed(2);
  add(ledger, 4);
  const block = text(call(ledger)[1]!);
  assert.match(block, /\n- c3 Rule 4\.$/);
  assert.ok(!/- c1 |- c2 /.test(block), "the brief holds c1 and code holds c2");
  landed(3);
  applyCorrection(ledger, parseCorrectionCall({ id: "c1", status: "retired" }), owner, "");
  assert.equal(call(ledger).length, 2);
});

test("a forty-rule snapshot shows the newest forty with no count line, and a 41st rule added later sends nothing", () => {
  const { branch, call } = session();
  const first = user("Owner prompt");
  branch.push(entry("first", first));
  const ledger: Ledger = { corrections: [] };
  for (let id = 1; id <= 41; id++) add(ledger, id);
  const initial = call([first], ledger);
  assert.equal(initial.length, 2);
  assert.equal(text(initial[1]!).split("\n").length, 41);
  assert.ok(!/older ones/.test(text(initial[1]!)));
  add(ledger, 42);
  assert.deepEqual(call([first], ledger), initial);
});
