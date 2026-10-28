import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION_LABEL, actionsFor, agentFromRoute, agentsIn, bytesLabel, canArchive, countsByTab, everyLabel, levelsFor, modelOptions, openTarget, sectionFromParams, shortPath, tabFromRoute } from "../../web/src/pages/agents/agents-model.ts";

type Agent = Parameters<typeof agentsIn>[0][number];
const agent = (over: Partial<Agent>): Agent => ({
  id: "t1", kind: "chat", name: "Vent", avatar: { initials: "VE", hue: 1 }, model: { provider: "anthropic", id: "claude-opus-5-5", label: "Opus 5.5" },
  thinkingLevel: "high", status: "idle", parent: null, thread: "t1", conversation: 1, archived: false, createdAt: 0, updatedAt: 0, preview: "", channels: [], host: "us-metal02",
  ...over,
});

test("Your agents holds chats by newest activity and Jobs puts working jobs first", () => {
  const list = [
    agent({ id: "a", updatedAt: 1 }),
    agent({ id: "b", updatedAt: 3 }),
    agent({ id: "c", archived: true, updatedAt: 9 }),
    agent({ id: "t:2", kind: "job", status: "idle", updatedAt: 8 }),
    agent({ id: "t:3", kind: "job", status: "working", updatedAt: 2 }),
    agent({ id: "t:4", kind: "job", status: "failed", updatedAt: 7 }),
  ];
  assert.deepEqual(agentsIn(list, "yours").map((a) => a.id), ["b", "a"]);
  assert.deepEqual(agentsIn(list, "jobs").map((a) => a.id), ["t:3", "t:4", "t:2"]);
  assert.deepEqual(countsByTab(list), { yours: 2, jobs: 3 });
});

test("Stop shows only while an agent works or waits", () => {
  assert.deepEqual(actionsFor(agent({ status: "working" })), ["open", "model", "stop", "archive"]);
  assert.deepEqual(actionsFor(agent({ status: "sleeping" })), ["open", "model", "stop", "archive"]);
  assert.deepEqual(actionsFor(agent({ status: "idle" })), ["open", "model", "archive"]);
  assert.deepEqual(actionsFor(agent({ status: "failed" })), ["open", "model", "archive"]);
});

test("a job opens its parent chat with the job's pane, a chat opens itself", () => {
  assert.deepEqual(openTarget(agent({ id: "t1" })), { id: "t1" });
  assert.deepEqual(openTarget(agent({ id: "t1:4", kind: "job", parent: { id: "t1", name: "Vent" } })), { id: "t1", thread: "t1:4" });
  assert.deepEqual(openTarget(agent({ id: "r2", kind: "job", parent: { id: "t1", name: "Vent" } })), { id: "t1", thread: "r2" });
});

test("models are keyed provider/id with family labels and their levels", () => {
  const catalog = { models: [{ provider: "anthropic", id: "claude-opus-5-5", label: "Opus 5.5", family: "claude", levels: ["low", "high"] as const }], default: { model: "anthropic/claude-opus-5-5", thinkingLevel: "high" as const } };
  const typed = catalog as unknown as Parameters<typeof modelOptions>[0];
  assert.deepEqual(modelOptions(typed), [{ id: "anthropic/claude-opus-5-5", label: "Opus 5.5", family: "Claude" }]);
  assert.deepEqual(levelsFor(typed, "anthropic/claude-opus-5-5"), ["low", "high"]);
  assert.deepEqual(levelsFor(typed, "x/y"), []);
  assert.equal(tabFromRoute(["jobs"]), "jobs");
  assert.equal(tabFromRoute([]), "yours");
});

test("#/agents/<id> names the agent whose configuration is open, over the tab it belongs to", () => {
  assert.equal(agentFromRoute([]), null);
  assert.equal(agentFromRoute(["jobs"]), null);
  assert.equal(agentFromRoute(["t1:4"]), "t1:4");
  assert.equal(tabFromRoute(["t1:4"], agent({ id: "t1:4", kind: "job" })), "jobs");
  assert.equal(tabFromRoute(["t1"], agent({ id: "t1" })), "yours");
  assert.equal(tabFromRoute(["t1"], null), "yours");
  assert.equal(sectionFromParams({ section: "memory" }), "memory");
  assert.equal(sectionFromParams({ section: "nope" }), "overview");
  assert.equal(sectionFromParams({}), "overview");
});

test("Message replaces Open thread, and only a root thread archives", () => {
  assert.equal(ACTION_LABEL.open, "Message");
  assert.equal(canArchive(agent({ conversation: 1 })), true);
  assert.equal(canArchive(agent({ id: "t1:4", kind: "job", conversation: 4 })), false);
});

test("sizes, home paths and check-in intervals read short", () => {
  assert.equal(bytesLabel(null), "");
  assert.equal(bytesLabel(512), "512 B");
  assert.equal(bytesLabel(25_714_688), "25 MB");
  assert.equal(bytesLabel(1536), "1.5 KB");
  assert.equal(shortPath("/home/sieun/.prime/agent/AGENTS.md"), "~/.prime/agent/AGENTS.md");
  assert.equal(shortPath("/Users/sieunpark/x"), "/Users/sieunpark/x");
  assert.equal(everyLabel(6 * 3600_000), "every 6 h");
  assert.equal(everyLabel(90 * 60_000), "every 90 min");
});
