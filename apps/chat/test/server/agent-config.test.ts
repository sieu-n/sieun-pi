/**
 * `GET /api/agents/:id/config` on the fixture host: identity and purpose, where it runs, its board, memory, instructions and swarm, and the
 * DM rule (one DM per agent; work threads, duty threads and jobs sit under their agent).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agent-config.test.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentConfig, ConversationSummary, Sidebar } from "../../web/src/lib/api/types.ts";
import { readPreamble } from "../../server/agent-config.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start({ wordMs: 0 });
});
after(async () => {
  await s.close();
});

const config = (id: string) => s.get<AgentConfig>(`/api/agents/${encodeURIComponent(id)}/config`);

test("a chat's config names its purpose, host, cwd, board, memory, instructions and swarm", async () => {
  const c = await config(agents.harness);
  assert.equal(c.agent.id, agents.harness);
  assert.equal(c.agent.room, "dm_ai-harness-developer-environment-vp");
  assert.equal(c.agent.home, join(s.app.config.dataDir, "work", "harness"));
  assert.equal(c.identity.purpose?.text, "What still blocks the migration to pi-host?");
  assert.equal(c.identity.purpose?.from.id, "owner");
  assert.equal(c.identity.duty, null);

  assert.equal(c.runs.host, "test-box");
  assert.equal(c.runs.hostKind, "fixture");
  assert.equal(c.runs.cwd, join(s.app.config.dataDir, "work", "harness"));
  assert.equal(c.runs.cwdExists, true);
  assert.equal(c.runs.thread, ids.harness);
  assert.equal(c.runs.conversation, 1);
  assert.equal(c.runs.threadFile, null, "the fixture host keeps threads in memory");
  assert.equal(c.runs.socket, s.app.config.socket);

  assert.ok(c.board);
  assert.equal(c.board.chat, agents.harness);
  assert.equal(c.board.own, true);
  assert.equal(c.board.doc, "chat.board");
  assert.deepEqual(c.board.goals.map(g => g.id), ["p1", "p7"]);
  assert.deepEqual(c.board.steps, { open: 5, done: 1, total: 6 });
  assert.equal(c.board.awaitingGo, (await s.get(`/api/agents/${agents.harness}/board`)).awaitingGo.length);
  assert.deepEqual(c.board.openTodos.map(t => t.id).sort(), ["t1", "t2"]);

  assert.equal(c.folder?.agent, agents.harness);
  assert.equal(c.folder?.dir, join(s.app.config.agentsDir, "ai-harness-developer-environment-vp"));
  assert.equal(c.memory.kind, "agent");
  assert.ok(c.memory.kind === "agent" && /harness store in its agent's folder/.test(c.memory.note));
  const harness = c.memory.related.find(f => f.path.endsWith("harness_state.json"));
  assert.equal(harness?.path, join(s.app.config.dataDir, "prime-agent", "harness", "harness_state.json"));
  assert.equal(harness?.count, 2);
  assert.equal(harness?.loaded, true, "pi-host's digest merges Prime's global store");
  assert.match(harness?.preview ?? "", /pi-pool slots free up/);
  assert.ok(c.memory.related.some(f => f.label === "duty d1 precheck state" && f.exists && /downMinutes/.test(f.preview ?? "")));

  const paths = c.instructions.files.map(f => f.path);
  assert.equal(paths[0], join(s.app.config.dataDir, "work", "harness", "AGENTS.md"), "the cwd's AGENTS.md comes first");
  assert.ok(paths.includes(join(s.app.config.dataDir, "work", "AGENTS.md")));
  assert.equal(paths.at(-1), join(s.app.config.dataDir, "prime-agent", "AGENTS.md"));
  assert.ok(c.instructions.files.every(f => f.loaded === true && f.exists && (f.size ?? 0) > 0), "pi-host loads them through Prime's resource loader");
  assert.match(c.instructions.files[0]!.preview ?? "", /Ask the owner before a deploy/);

  const jobs = new Map(c.swarm.jobs.map(j => [j.id, j]));
  assert.equal(jobs.get(ids.uptimeDuty)?.kind, "duty");
  assert.equal(jobs.get(ids.cutover)?.kind, "root job");
  assert.ok(c.swarm.jobs.some(j => j.kind === "job" && j.id.startsWith(`${ids.harness}:`) && j.status === "working"));
  assert.deepEqual(c.swarm.channels, [{ id: "ch_cutover", name: "pi-cutover" }]);
  assert.deepEqual(c.swarm.duties.map(d => [d.id, d.schedule, d.paused]), [["d1", "daily at 07:40 KST", false], ["d2", "daily at 07:40 KST", true]]);
  assert.equal(c.swarm.checkIn?.everyMs, 120 * 60_000);
  assert.equal(c.swarm.dutiesFile?.path, join(s.app.config.dataDir, "agents", agents.harness, "duties.json"));
  assert.ok(c.usage && c.usage.days === 7);
});

test("a duty thread names its duty and the brief it was given, and shares its chat's board", async () => {
  const c = await config(ids.uptimeDuty);
  assert.equal(c.agent.kind, "job");
  assert.deepEqual(c.identity.duty, { chat: agents.harness, id: "d1", name: "Relay uptime" });
  assert.equal(c.identity.purpose?.from.id, agents.harness);
  assert.equal(c.identity.purpose?.via, "duty d1");
  assert.match(c.identity.purpose?.text ?? "", /^You are the duty job/);
  assert.equal(c.board?.chat, agents.harness);
  assert.equal(c.board?.own, false);
  assert.deepEqual(c.swarm.duties, [], "duties belong to the chat");
  assert.equal(c.swarm.parent?.id, agents.harness);
  assert.equal(c.folder?.agent, agents.harness, "a duty thread shares its agent's folder");
  assert.equal(c.memory.kind, "agent");
});

test("a job inside a thread reads its task as its purpose and its thread's board", async () => {
  const job = (await s.get<ConversationSummary[]>("/api/conversations")).find(c => c.id.startsWith(`${ids.vent}:`))!;
  const c = await config(job.id);
  assert.match(c.identity.purpose?.text ?? "", /Read the canary logs/);
  assert.equal(c.runs.thread, ids.vent);
  assert.notEqual(c.runs.conversation, 1);
  assert.equal(c.board?.chat, agents.vent);
  assert.equal(c.board?.own, false);
});

test("an unknown agent is a 404", async () => {
  const response = await s.send("GET", "/api/agents/no-such-agent/config");
  assert.equal(response.status, 404);
});

test("Direct messages hold one row per agent; work threads, a duty thread, a root job and a job open by link", async () => {
  const sidebar = await s.get<Sidebar>("/api/sidebar");
  assert.deepEqual(sidebar.dms.map(c => c.id).sort(), ["dm_ai-harness-developer-environment-vp", "dm_crawler-vp", "dm_frontend-bro", "dm_vent"]);
  assert.deepEqual(sidebar.solo, []);
  const all = await s.get<ConversationSummary[]>("/api/conversations");
  const duty = all.find(c => c.id === ids.uptimeDuty);
  assert.equal(duty?.kind, "job");
  assert.equal(duty?.parent, agents.harness);
  assert.equal(all.find(c => c.id === ids.cutover)?.kind, "job");
  assert.equal(all.find(c => c.id === ids.vent)?.kind, "job", "a work thread opens from its agent, not the sidebar");
  const opened = await s.send("POST", "/api/dms", { agent: ids.cutover });
  assert.equal(opened.body.id, "dm_ai-harness-developer-environment-vp", "a root job's DM is its agent's");
  assert.equal((await s.get(`/api/c/${ids.uptimeDuty}`)).summary.kind, "job");
});

test("the preamble parses from pi-family's source", () => {
  const got = readPreamble([join(import.meta.dirname, "../../../../packages/pi-family/preamble.ts")]);
  assert.match(got.text ?? "", /^You are a general purpose agent/);
  assert.equal(got.text?.split("\n").length, 3);
  assert.equal(readPreamble(["/no/such/file"]).text, null);
});
