import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import { AgentStore } from "../../server/agent-store.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import type { ContentBlock, EntryRecord } from "../../server/host/types.ts";
import { migrateAgents } from "../../server/migrate.ts";
import { Rooms } from "../../server/rooms.ts";
import { TELL_OWNER_HELD } from "../../web/src/lib/api/shared/chat-feed.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 29, 0, 0);
const T0 = NOW - 2 * DAY;

let dir: string;
let host: FixtureHost;
let vent: ReturnType<FixtureHost["addThread"]>;
let factory: ReturnType<FixtureHost["addThread"]>;
const JOB_THREAD = "job-thread-1";
let clock = T0;
const tick = () => (clock += 1000);

const user = (text: string) => ({ kind: "pi.user", model: [{ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: tick() }] });
const agentMessage = (text: string, data: { from: string; via?: string }) => ({ kind: "agent.message", model: [{ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: tick() }], data });
const assistant = (content: ContentBlock[]) => ({ kind: "pi.assistant", model: [{ role: "assistant" as const, content, timestamp: tick(), stopReason: "stop" }] });
const call = (id: string, text: string, extra: Record<string, unknown> = {}): ContentBlock => ({ type: "toolCall", id, name: "tell_owner", arguments: { text, ...extra } });
const result = (id: string, text: string, opts: { isError?: boolean; toolName?: string; details?: Record<string, unknown> } = {}) => ({
  kind: "pi.tool-result",
  model: [{ role: "toolResult" as const, toolCallId: id, toolName: opts.toolName ?? "tell_owner", content: [{ type: "text" as const, text }], isError: opts.isError ?? false, timestamp: tick(), ...(opts.details ? { details: opts.details } : {}) }],
});

function files(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(root, path), readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return out;
}

let pendingCall: EntryRecord;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "apps-chat-migrate-"));
  host = new FixtureHost();
  host.wordMs = 0;
  vent = host.addThread({ id: "vent-thread", name: "vent", createdAt: T0 - 10 * DAY });
  vent.row.cwd = "/work/vent";
  factory = host.addThread({ id: "factory-thread", name: "agent factory", createdAt: T0 - DAY });
  host.addThread({ id: JOB_THREAD, name: "vent duty run", createdAt: T0 });
  host.addThread({ id: "old-thread", name: "old", createdAt: T0, archived: true });

  // vent: an old turn outside the window, a text turn from before the first call, then turns that speak through tell_owner.
  clock = NOW - 40 * DAY;
  host.append(vent, 1, user("too old to copy"));
  host.append(vent, 1, assistant([{ type: "text", text: "old answer" }]));
  clock = T0;
  host.append(vent, 1, user("is vent up?"));
  host.append(vent, 1, assistant([{ type: "text", text: "Yes, vent answers on staging." }]));
  host.append(vent, 1, user(`<skill name="unslop" location="/x/SKILL.md">\nbody\n</skill>\n\nsay it plainly`));
  host.append(vent, 1, assistant([{ type: "text", text: "a private note" }, call("c1", "Plain: vent is up.", { why: "answer" })]));
  host.append(vent, 1, result("c1", "told the owner"));
  host.append(vent, 1, assistant([{ type: "toolCall", id: "s1", name: "ipython", arguments: { code: "rlm.spawn()" } }]));
  host.append(vent, 1, result("s1", "spawned", { toolName: "ipython", details: { conversations: [7] } }));
  host.append(vent, 1, assistant([call("c2", "Started a job for the webhooks.")]));
  host.append(vent, 1, result("c2", "told the owner"));
  host.append(vent, 1, user("[job] vent webhooks stopped on a pause"));
  host.append(vent, 1, assistant([call("c3", "held one", { why: "update" })]));
  host.append(vent, 1, result("c3", `${TELL_OWNER_HELD}.`));
  host.append(vent, 1, assistant([call("c4", "refused one")]));
  host.append(vent, 1, result("c4", "Not sent", { isError: true }));
  host.append(vent, 1, agentMessage("@vent what is the status?", { from: "owner", via: "#vent-dev" }));
  host.append(vent, 1, assistant([call("c5", "In the channel: all green.")]));
  host.append(vent, 1, result("c5", "told the owner"));
  host.append(vent, 1, user("[board] Owner chose \"Send it\" for \"Test DM\""));
  host.append(vent, 1, agentMessage("[agent-message from AI harness VP] check this", { from: "AI harness VP" }));
  host.append(vent, 1, user("and the prod deploy?"));
  pendingCall = host.append(vent, 1, assistant([call("c6", "Prod deploys at 10:00.", { why: "answer" })]));
  vent.row.status = "running";

  host.append(factory, 1, user("build the agents view"));
  host.append(factory, 1, assistant([{ type: "toolCall", id: "s2", name: "subagent", arguments: { task: "x" } }]));
  host.append(factory, 1, result("s2", "started", { toolName: "subagent", details: { conversationId: 9 } }));
  host.append(factory, 1, assistant([call("f1", "On it.")]));
  host.append(factory, 1, result("f1", "told the owner"));

  writeFileSync(join(dir, "state.json"), JSON.stringify({
    v: 1, threads: { [JOB_THREAD]: { kind: "job", parent: "vent-thread" } }, dms: [], reads: { "vent-thread": { at: T0 + 6500 } },
  }));
  mkdirSync(join(dir, "boards", "vent-thread", "duties"), { recursive: true });
  writeFileSync(join(dir, "boards", "vent-thread", "duties.json"), "{\"duties\":[]}\n");
  writeFileSync(join(dir, "boards", "vent-thread", "duties", "d1.state.json"), "{}\n");
});

after(() => rmSync(dir, { recursive: true, force: true }));

const run = (apply: boolean) => migrateAgents(host, dir, { apply, box: "test-box", now: () => NOW });

test("a dry run reports the agents and posts and writes nothing", async () => {
  const before = files(dir);
  const report = await run(false);
  assert.deepEqual(files(dir), before);
  assert.deepEqual(readdirSync(dir).sort(), ["boards", "state.json"]);
  assert.deepEqual(report.agents.map(a => a.id).sort(), ["ag_agent-factory", "ag_vent"]);
  assert.equal(report.aliases[JOB_THREAD], "ag_vent");
});

test("apply makes the agents, aliases, rooms, posts, cursor, board copy and read mark", async () => {
  const report = await run(true);
  const store = new AgentStore(dir);
  const ventAgent = store.agentOf("vent-thread")!;
  assert.equal(ventAgent.id, "ag_vent");
  assert.equal(ventAgent.room, "dm_vent");
  assert.equal(ventAgent.home, "/work/vent");
  assert.equal(ventAgent.host, "test-box");
  assert.equal(store.agentOf(JOB_THREAD)?.id, "ag_vent");
  assert.equal(store.agentOf("factory-thread")?.id, "ag_agent-factory");
  assert.equal(store.agentOf("old-thread"), undefined);
  assert.deepEqual(store.rooms.rooms.map(r => r.id).sort(), ["dm_agent-factory", "dm_vent"]);

  const posts = store.postsOf("dm_vent");
  assert.deepEqual(posts.map(p => [p.author, p.text]), [
    ["owner", "is vent up?"],
    ["ag_vent", "Yes, vent answers on staging."],
    ["owner", "say it plainly"],
    ["ag_vent", "Plain: vent is up."],
    ["ag_vent", "Started a job for the webhooks."],
    ["owner", "and the prod deploy?"],
  ]);
  assert.deepEqual(posts.map(p => p.seq), [1, 2, 3, 4, 5, 6]);
  assert.ok(posts.every(p => p.imported && p.requestId.startsWith("h:vent-thread:")));
  assert.equal(posts[3]!.requestId, "h:vent-thread:c1");
  assert.equal(posts[3]!.why, "answer");
  assert.equal(posts[1]!.requestId.startsWith("h:vent-thread:t"), true);
  assert.deepEqual(posts[3]!.jobs, ["vent-thread:7"]);
  assert.equal(posts[4]!.jobs, undefined);
  assert.deepEqual(store.postsOf("dm_agent-factory").map(p => [p.text, p.jobs]), [["build the agents view", undefined], ["On it.", ["factory-thread:9"]]]);
  assert.equal(posts[3]!.source?.thread, "vent-thread");
  assert.equal(report.agents.find(a => a.id === "ag_vent")!.posts.length, 6);

  const cursor = store.rooms.feed["ag_vent"]!;
  assert.equal(cursor.entry, pendingCall.id);
  assert.deepEqual(cursor.open, { c6: { text: "Prod deploys at 10:00.", entry: pendingCall.id, why: "answer" } });
  assert.equal(cursor.turn?.channel, false);
  assert.equal(store.agents.agents.find(a => a.id === "ag_vent")!.migrated?.posts, 6);

  assert.equal(readFileSync(join(dir, "agents", "ag_vent", "duties.json"), "utf8"), "{\"duties\":[]}\n");
  assert.equal(readFileSync(join(dir, "agents", "ag_vent", "duties", "d1.state.json"), "utf8"), "{}\n");
  assert.ok(statSync(join(dir, "boards", "vent-thread", "duties.json")).isFile());
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.deepEqual(state.reads["dm_vent"], { at: T0 + 6500, seq: 4 });
  assert.ok(state.reads["vent-thread"]);
});

test("a second apply changes nothing", async () => {
  const before = files(dir);
  const report = await run(true);
  assert.deepEqual(files(dir), before);
  assert.ok(report.agents.every(a => !a.created && a.posts.length === 0));
  assert.deepEqual(report.aliases, {});
});

test("the live feed starts at the cursor: the open call and a later call post once, and migrated posts stay", async () => {
  host.append(vent, 1, result("c6", "told the owner"));
  host.append(vent, 1, assistant([call("c7", "Deployed.")]));
  host.append(vent, 1, result("c7", "told the owner"));
  const store = new AgentStore(dir);
  const record = store.agentOf("vent-thread")!;
  const deps = {
    store, host, state: { state: { reads: {} }, saveState() {} },
    agents: { migrationRunning: false, record: () => record, list: () => [record], roomThread: () => record.workThread },
    threads: { tree: () => [], principal: (id: string) => ({ id, kind: "chat", name: id, avatar: { initials: "AG", hue: 0 } }), statusOfConversation: () => "idle", agent: () => undefined },
    events: { items() {}, status() {}, changed() {}, submitted() {} },
    saveUpload: () => { throw new Error("no uploads"); }, readUpload: () => undefined, log() {},
  };
  const rooms = new Rooms(deps as unknown as ConstructorParameters<typeof Rooms>[0]);
  await rooms.feed(record);
  await rooms.feed(record);
  const posts = store.postsOf("dm_vent");
  assert.deepEqual(posts.slice(6).map(p => [p.requestId, p.text]), [["m:vent-thread:c6", "Prod deploys at 10:00."], ["m:vent-thread:c7", "Deployed."]]);
  assert.equal(posts.filter(p => p.text === "Plain: vent is up.").length, 1);
  assert.deepEqual(store.rooms.feed["ag_vent"]!.open, {});
  assert.equal((await run(true)).agents.find(a => a.id === "ag_vent")!.posts.length, 0);
  assert.equal(new AgentStore(dir).postsOf("dm_vent").length, 8);
});
