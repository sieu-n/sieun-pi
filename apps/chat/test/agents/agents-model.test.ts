import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION_LABEL, actionsFor, agentFromRoute, agentsIn, bytesLabel, canArchive, countsByTab, everyLabel, jobCounts, jobGroups, jobsLabel, levelsFor, modelOptions, openTarget, sectionFromParams, shortPath, tabFromRoute } from "../../web/src/pages/agents/agents-model.ts";

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

test("an agent opens its DM, a job opens its agent's DM with the job's pane, and a thread no agent holds opens itself", () => {
  const room = (id: string) => (id.startsWith("ag_") ? `dm_${id.slice(3)}` : id);
  assert.deepEqual(openTarget(agent({ id: "ag_vent", room: "dm_vent" }), room), { id: "dm_vent" });
  assert.deepEqual(openTarget(agent({ id: "ag_vent" }), room), { id: "dm_vent" });
  assert.deepEqual(openTarget(agent({ id: "t1:4", kind: "job", parent: { id: "ag_vent", name: "Vent" } }), room), { id: "dm_vent", thread: "t1:4" });
  assert.deepEqual(openTarget(agent({ id: "r2", kind: "job", parent: { id: "ag_vent", name: "Vent" } }), room), { id: "dm_vent", thread: "r2" });
  assert.deepEqual(openTarget(agent({ id: "t1" })), { id: "t1" });
});

test("Jobs groups each agent's jobs under it, newest group first, and an agent's card counts its live jobs", () => {
  const vent = { id: "ag_vent", name: "Vent" };
  const vp = { id: "ag_vp", name: "VP" };
  const list = [
    agent({ id: "ag_vent", room: "dm_vent" }),
    agent({ id: "v:2", kind: "job", parent: vent, updatedAt: 2 }),
    agent({ id: "v:3", kind: "job", parent: vent, status: "working", updatedAt: 1 }),
    agent({ id: "p:2", kind: "job", parent: vp, updatedAt: 5 }),
    agent({ id: "p:3", kind: "job", parent: vp, archived: true, updatedAt: 9 }),
    agent({ id: "x", kind: "job", parent: null, updatedAt: 8 }),
  ];
  assert.deepEqual(jobGroups(list).map((group) => [group.parent?.id ?? null, group.jobs.map((job) => job.id)]), [["ag_vp", ["p:2"]], ["ag_vent", ["v:3", "v:2"]], [null, ["x"]]]);
  const counts = jobCounts(list);
  assert.equal(jobsLabel(counts.get("ag_vent")), "2 jobs, 1 working");
  assert.equal(jobsLabel(counts.get("ag_vp")), "1 job");
  assert.equal(jobsLabel(counts.get("ag_none")), null);
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
