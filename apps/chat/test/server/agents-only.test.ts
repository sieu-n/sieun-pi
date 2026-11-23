/**
 * Agents are registered templates, and threads and jobs are their work: `/api/agents` and `hello` hold registered agents only, `/api/jobs`
 * holds the jobs that work for them, a mention or a channel member reaches a registered agent only, the poll registers no root chat, the
 * migrate CLI skips untitled ones, and the first thread list drops the records the old poll-time migration made from untitled chats.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agents-only.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { AgentSummary, ConversationSummary, LiveEvent, Sidebar } from "../../web/src/lib/api/types.ts";
import { AgentStore } from "../../server/agent-store.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import type { EntryRecord } from "../../server/host/types.ts";
import { migrateAgents } from "../../server/migrate.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
let host: FixtureHost;
before(async () => {
  s = await start();
  host = s.host as FixtureHost;
});
after(async () => {
  await s.close();
});

const REGISTERED = [agents.harness, agents.crawler, agents.frontend, agents.vent].sort();
const VENT_JOB = "Read the canary logs from the last day and list every relay error";
const jobId = (name: string): string => s.app.threads.jobList().find(j => j.name === name)!.id;
/** The agent messages a thread got from the owner through `via`. */
const mentionsIn = (thread: string, via: string): EntryRecord[] =>
  host.threadsById.get(thread)!.entries.filter(e => e.kind === "agent.message" && (e.data as { via?: string } | undefined)?.via === via);

describe("lists", () => {
  test("/api/agents holds the registered agents only, newest first", async () => {
    const list = await s.get<AgentSummary[]>("/api/agents");
    assert.deepEqual(list.map(a => a.id).sort(), REGISTERED);
    assert.ok(list.every(a => a.kind === "chat" && a.id.startsWith("ag_") && a.room?.startsWith("dm_")));
    assert.deepEqual(list.map(a => a.updatedAt), list.map(a => a.updatedAt).sort((a, b) => b - a));
    const archived = await s.get<AgentSummary[]>("/api/agents?archived=1");
    assert.deepEqual(archived.map(a => a.id).sort(), [...REGISTERED, "ag_old-relay-probe"].sort());
  });

  test("/api/jobs holds every job of a registered agent with its agent, also under a job, and nothing of a chat no agent holds", async () => {
    const jobs = await s.get<AgentSummary[]>("/api/jobs");
    assert.ok(jobs.every(j => j.kind === "job" && j.agent !== undefined));
    assert.ok(!jobs.some(j => j.thread === ids.solo), "the solo chat's job is in no list");
    const byName = (name: string) => jobs.find(j => j.name === name)!;
    const ventJob = byName(VENT_JOB);
    assert.deepEqual(ventJob.agent, { id: agents.vent, name: "Vent" });
    assert.equal(ventJob.parent?.id, agents.vent);
    const nested = byName("error timestamps");
    assert.equal(nested.parent?.id, ventJob.id, "a job of a job keeps its job as parent");
    assert.deepEqual(nested.agent, { id: agents.vent, name: "Vent" });
    for (const root of [ids.cutover, ids.uptimeDuty]) assert.equal(jobs.find(j => j.id === root)?.agent?.id, agents.harness);
    assert.equal(byName("Rerun the cross-box test on the canary relay").agent?.id, agents.harness);
    const directory = await s.get<{ agents: AgentSummary[]; jobs: AgentSummary[] }>("/api/directory");
    assert.deepEqual(directory.agents.map(a => a.id), (await s.get<AgentSummary[]>("/api/agents")).map(a => a.id));
    assert.deepEqual(directory.jobs.map(j => j.id), jobs.map(j => j.id));
  });

  test("/api/jobs?agent= holds that agent's jobs only, archived ones with archived=1, and answers 404 for an id no agent has", async () => {
    // On 11-24 live GET /api/jobs?agent=ag_agent-factory answered every agent's 1,925 jobs, 1.1 MB, because the route read no agent.
    for (const archived of ["", "&archived=1"]) {
      const all = await s.get<AgentSummary[]>(`/api/jobs?${archived.slice(1)}`);
      for (const agent of REGISTERED) {
        const mine = await s.get<AgentSummary[]>(`/api/jobs?agent=${agent}${archived}`);
        assert.deepEqual(mine.map(j => j.id), all.filter(j => j.agent?.id === agent).map(j => j.id), `${agent}${archived}`);
      }
    }
    const vent = await s.get<AgentSummary[]>(`/api/jobs?agent=${agents.vent}`);
    assert.ok(vent.length > 0 && vent.length < (await s.get<AgentSummary[]>("/api/jobs")).length);
    assert.equal((await s.send("GET", "/api/jobs?agent=ag_nobody")).status, 404);
  });

  test("the sidebar's Solo group holds Solo rooms only, never a root chat no agent holds", async () => {
    const sidebar = await s.get<Sidebar>("/api/sidebar");
    assert.ok(sidebar.solo.every(c => c.id.startsWith("so_")));
    assert.ok(![...sidebar.solo, ...sidebar.dms].some(c => c.id === ids.solo || c.name === "New thread"));
  });

  test("hello carries the registered agents and their jobs", async () => {
    const live = await s.live();
    const hello = await live.waitFor((e): e is Extract<LiveEvent, { type: "hello" }> => e.type === "hello");
    assert.deepEqual(hello.agents.map(a => a.id).sort(), REGISTERED);
    assert.ok(hello.jobs.length > 0 && hello.jobs.every(j => j.kind === "job" && j.agent));
    assert.ok(!hello.jobs.some(j => j.thread === ids.solo));
    live.close();
  });

  test("a job a registered agent starts goes out as a job event, never as an agent event", async () => {
    const live = await s.live();
    await live.waitFor(e => e.type === "hello");
    await s.send("POST", `/api/c/${ids.crawler}/send`, { text: "spawn a job for the port", requestId: "ao-spawn-1" });
    const event = await live.waitFor((e): e is Extract<LiveEvent, { type: "job" }> => e.type === "job" && e.job.thread === ids.crawler);
    assert.equal(event.job.agent?.id, agents.crawler);
    assert.ok(!live.events.some(e => e.type === "agent" && !e.agent.id.startsWith("ag_")));
    live.close();
  });
});

describe("mentions and members", () => {
  test("a mention in a thread send reaches a registered agent's work thread, and a job, a bare thread and a job's name get nothing", async () => {
    const ventJob = jobId(VENT_JOB);
    // The agent comes last, so a delivery to any target before it would have landed by the time the agent's has.
    const sent = await s.send("POST", `/api/c/${ids.frontend}/send`, {
      text: "@Vent and the others, look at this", requestId: "ao-mention-1", mentions: [ids.cutover, ventJob, ids.solo, "error timestamps", agents.vent],
    });
    assert.equal(sent.status, 200);
    await until(async () => mentionsIn(ids.vent, ids.frontend).length, n => n === 1);
    assert.equal(mentionsIn(ids.cutover, ids.frontend).length, 0);
    assert.equal(mentionsIn(ids.solo, ids.frontend).length, 0);
    assert.ok(!host.threadsById.get(ids.vent)!.entries.some(e => e.conversationId !== 1 && e.kind === "agent.message" && (e.data as { via?: string }).via === ids.frontend));
  });

  test("a mention in a DM post reaches the mentioned agent, by id or by its DM room, and a bare thread gets nothing", async () => {
    const sent = await s.send("POST", "/api/c/dm_vent/send", { text: "@Crawler VP what port?", requestId: "ao-dm-1", mentions: [ids.solo, "dm_crawler-vp"] });
    assert.equal(sent.status, 200);
    await until(async () => mentionsIn(ids.crawler, "dm_vent").length, n => n === 1);
    assert.equal(mentionsIn(ids.solo, "dm_vent").length, 0);
  });

  test("a channel mention of a job is dropped, and the post reaches only the channel's agents", async () => {
    const sent = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "@pi cutover prep status?", mentions: [ids.cutover], requestId: "ao-ch-1" });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.deliveries.map((d: { target: string }) => d.target), [agents.harness, agents.crawler, agents.frontend]);
    assert.deepEqual(sent.body.item.mentions, []);
  });

  test("a name finds the registered agent before a job, and only a registered agent is a target", () => {
    assert.equal(s.app.threads.principal("Vent").id, agents.vent);
    assert.equal(s.app.threads.registered("Vent")?.id, agents.vent);
    assert.equal(s.app.threads.registered(ids.vent)?.id, agents.vent, "a work thread names its agent");
    assert.equal(s.app.threads.registered("error timestamps"), undefined);
    assert.equal(s.app.threads.registered(ids.cutover), undefined, "a root job is no target");
    assert.equal(s.app.threads.registered(ids.solo), undefined);
  });

  test("a room takes a registered agent or its work thread as a member and refuses a job, a bare thread or a comm thread", async () => {
    const channel = (await s.send("POST", "/api/rooms", { kind: "channel", name: "agents-only", agenda: "members" })).body;
    await s.send("POST", "/api/c/dm_vent/send", { text: "make your comm thread", requestId: "ao-comm-1" });
    const comm = await until(async () => s.app.agents.record(agents.vent)!.comm?.dm_vent, id => id !== undefined);
    for (const bad of [ids.cutover, jobId(VENT_JOB), ids.solo, comm!]) {
      const refused = await s.send("POST", `/api/rooms/${channel.id}/members`, { agents: [bad] });
      assert.equal(refused.status, 400, bad);
      assert.match(refused.body.error, /only a registered agent joins a room/);
    }
    const added = await s.send("POST", `/api/rooms/${channel.id}/members`, { agents: [agents.crawler, ids.vent] });
    assert.deepEqual(added.body.members.map((m: { principal: { id: string } }) => m.principal.id), ["owner", agents.crawler, agents.vent]);
    assert.equal((await s.send("POST", "/api/rooms", { kind: "channel", name: "agents-only-2", members: [ids.solo] })).status, 400);
    assert.equal((await s.send("POST", "/api/rooms", { kind: "solo", agenda: "jobs only", members: [ids.cutover] })).status, 400);
  });
});

describe("registration", () => {
  test("the poll makes no agent of a new root chat, named or not", async () => {
    const before = s.app.agentStore.agents.agents.length;
    const untitled = host.addThread({ name: "New thread", createdAt: Date.now() }).row.id;
    const named = host.addThread({ name: "relay notes", createdAt: Date.now() }).row.id;
    for (let i = 0; i < 3; i++) await s.app.threads.refresh();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(s.app.agentStore.agents.agents.length, before);
    const list = await s.get<AgentSummary[]>("/api/agents");
    assert.ok(!list.some(a => a.thread === untitled || a.thread === named));
    const solo = (await s.get<Sidebar>("/api/sidebar")).solo.map(c => c.id);
    assert.ok(!solo.includes(untitled) && !solo.includes(named));
  });

  test("a root thread a job started with rlm.create_session is filed under the job's agent, and so is one that job started", async () => {
    const at = Date.now();
    const brief = (text: string) => [{ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: at }];
    // pi-host's rlm.create_session makes a root thread and gives it its first input as an agent message from the calling thread.
    const spawned = host.addThread({ name: "dropped pages cause", createdAt: at });
    host.append(spawned, 1, { kind: "agent.message", data: { from: ids.cutover, via: "rlm.create_session" }, model: brief("Find why pages dropped.") });
    const nested = host.addThread({ name: "dropped pages round 2", createdAt: at + 1 });
    host.append(nested, 1, { kind: "agent.message", data: { from: spawned.row.id, via: "rlm.create_session" }, model: brief("Refresh the stats.") });
    const owners = host.addThread({ name: "New thread", createdAt: at + 2 });
    host.append(owners, 1, { kind: "pi.user", model: brief("does sft distillation work?") });
    const passes = await Promise.all([s.app.agents.fileSpawned(new Map([spawned, nested, owners].map(t => [t.row.id, t.row]))), s.app.threads.refresh()]);
    assert.deepEqual(passes[0], [spawned.row.id, nested.row.id], "a refresh during a pass gets that pass and files nothing twice");
    const jobs = await s.get<AgentSummary[]>("/api/jobs");
    for (const thread of [spawned, nested]) {
      assert.equal(jobs.find(j => j.id === thread.row.id)?.agent?.id, agents.harness, `${thread.row.name} is a job of the agent whose job started it`);
      assert.deepEqual(s.app.store.state.threads[thread.row.id], { kind: "job", parent: agents.harness });
    }
    assert.ok(!jobs.some(j => j.id === owners.row.id), "a root chat the owner started is no job");
    assert.ok((await s.get<Sidebar>("/api/sidebar")).solo.every(c => c.id.startsWith("so_")));
  });

  test("the migrate CLI skips an untitled root chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apps-chat-untitled-"));
    try {
      const cli = new FixtureHost();
      for (const name of ["New thread", "Untitled", "", "Relay desk"]) cli.addThread({ name, createdAt: Date.now() });
      const report = await migrateAgents(cli, dir, { apply: true, box: "test-box" });
      assert.deepEqual(new AgentStore(dir).agents.agents.map(a => a.name), ["Relay desk"]);
      assert.deepEqual(report.skipped.map(c => c.name).sort(), ["", "New thread", "Untitled"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the first thread list drops every untitled agent with its aliases and archives its DM, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apps-chat-drop-"));
    const fresh = new FixtureHost();
    const at = Date.now() - 60_000;
    const untitled = fresh.addThread({ name: "New thread", createdAt: at }).row.id;
    const renamed = fresh.addThread({ name: "relay notes", createdAt: at }).row.id;
    const made = fresh.addThread({ name: "New thread", createdAt: at }).row.id;
    const job = fresh.addThread({ name: "probe", createdAt: at }).row.id;
    const store = new AgentStore(dir);
    const record = (slug: string, thread: string, migrated: boolean) => {
      store.agents.agents.push({
        id: `ag_${slug}`, slug, name: "New thread", room: `dm_${slug}`, workThread: thread, host: "test-box", home: "/tmp", createdAt: at, archived: false,
        ...(migrated ? { migrated: { at, posts: 0, since: at } } : {}),
      });
      store.agents.aliases[thread] = `ag_${slug}`;
      store.rooms.rooms.push({ id: `dm_${slug}`, kind: "dm", agent: `ag_${slug}`, createdAt: at, archived: false });
    };
    record("new-thread", untitled, true);
    record("new-thread-2", renamed, true);
    // The composer's "new chat" made this one through POST /api/agents with no name, as ag_new-thread-4 on the live server was.
    record("new-thread-3", made, false);
    store.agents.aliases[job] = "ag_new-thread";
    store.saveAgents();
    store.saveRooms();
    let server = await start({ dataDir: dir, host: fresh });
    try {
      const kept = (await server.get<AgentSummary[]>("/api/agents")).map(a => a.id).sort();
      assert.deepEqual(kept, ["ag_new-thread-2"], "only the agent whose work thread got a name stays");
      const saved = new AgentStore(dir);
      assert.ok(!saved.agents.agents.some(a => a.id === "ag_new-thread"));
      assert.equal(saved.agents.aliases[untitled], undefined);
      assert.equal(saved.agents.aliases[job], undefined);
      assert.equal(saved.rooms.rooms.find(r => r.id === "dm_new-thread")?.archived, true);
      const chats = (await server.get<ConversationSummary[]>("/api/conversations")).filter(c => c.kind === "solo").map(c => c.id);
      assert.ok(chats.includes(untitled) && chats.includes(made), "each is a root chat no agent holds again");
      assert.ok(!(await server.get<Sidebar>("/api/sidebar")).dms.some(c => c.id === "dm_new-thread"));
      await server.close();
      server = await start({ dataDir: dir, host: fresh });
      assert.deepEqual((await server.get<AgentSummary[]>("/api/agents")).map(a => a.id).sort(), kept);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
