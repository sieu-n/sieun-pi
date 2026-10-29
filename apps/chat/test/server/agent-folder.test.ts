/**
 * The agent folder on the fixture host (apps/chat/docs/agent-model.md, phase 3): the agent.ref sweep, the brief and memory routes, the
 * harness store in Prime's on-disk format as pi-host's copy of Prime's reader loads it, and the config's folder and memory kind.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agent-folder.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentConfig, AgentFolder, AgentSummary, ConversationSummary } from "../../web/src/lib/api/types.ts";
import { AGENT_REF_DOC, harnessSlug } from "../../server/agent-folder.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, until, type Running } from "./helpers.ts";

type LoadedEntry = { id: string; kind: string; title: string; content: string; path: string; scope?: string; source: string; reference: object; created_at: string; updated_at: string; version: number };
// pi-host's verbatim copy of Prime's reader. It is imported by a path tsc does not follow, because Prime's code does not pass this package's
// noUncheckedIndexedAccess.
const vendor = "../../../../packages/pi-host/src/durable/vendor/prime-harness.ts";
let loadHarnessState: (dir: string, scope: "local" | "global") => { entries: Record<"memory", Record<string, LoadedEntry | undefined>> };

let s: Running;
before(async () => {
  ({ loadHarnessState } = await import(vendor));
  s = await start({ wordMs: 0 });
});
after(async () => {
  await s.close();
});

const host = () => s.host as FixtureHost;
const refOf = (h: FixtureHost, thread: string) => h.threadsById.get(thread)?.docs.get(AGENT_REF_DOC);
const folder = (id: string) => s.get<AgentFolder>(`/api/agents/${encodeURIComponent(id)}/folder`);
const ventDir = () => join(s.app.config.agentsDir, "vent");
const storeFile = () => join(ventDir(), "harness", "harness_state.json");

test("the sweep writes agent.ref into each work thread and root job thread once, and a second server's sweep writes nothing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-refs-"));
  const first = await start({ dataDir });
  try {
    const h = first.host as FixtureHost;
    const dirOf = (slug: string) => join(first.app.config.agentsDir, slug);
    await until(async () => refOf(h, ids.uptimeDuty), ref => ref !== undefined);
    assert.deepEqual(refOf(h, ids.vent), { agent: agents.vent, dir: dirOf("vent"), role: "work" });
    assert.deepEqual(refOf(h, ids.harness), { agent: agents.harness, dir: dirOf("ai-harness-developer-environment-vp"), role: "work" });
    assert.deepEqual(refOf(h, ids.cutover), { agent: agents.harness, dir: dirOf("ai-harness-developer-environment-vp"), role: "job" });
    assert.deepEqual(refOf(h, ids.uptimeDuty), { agent: agents.harness, dir: dirOf("ai-harness-developer-environment-vp"), role: "job" });

    await first.app.agents.sweepRefs();
    const puts: string[] = [];
    let gets = 0;
    const put = h.docPut.bind(h);
    const get = h.docGet.bind(h);
    h.docPut = async (thread, name, value) => {
      puts.push(thread);
      return put(thread, name, value);
    };
    h.docGet = async (thread, name) => {
      gets += 1;
      return get(thread, name);
    };
    const second = await start({ dataDir, host: h });
    try {
      await second.app.agents.sweepRefs();
      assert.ok(gets >= 4, `the second server read each ref (${gets} reads)`);
      assert.deepEqual(puts, [], "every ref was already there");
    } finally {
      await second.close();
      h.docPut = put;
      h.docGet = get;
    }
  } finally {
    await first.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a new agent's work thread and a root job filed under an agent get their ref at once", async () => {
  const made = await s.send<AgentSummary>("POST", "/api/agents", { name: "Ref probe" });
  assert.equal(made.status, 200);
  await until(async () => refOf(host(), made.body.thread), ref => ref !== undefined);
  assert.deepEqual(refOf(host(), made.body.thread), { agent: "ag_ref-probe", dir: join(s.app.config.agentsDir, "ref-probe"), role: "work" });

  const job = await s.send<AgentSummary>("POST", "/api/agents", { name: "Ref probe job", kind: "job", parent: agents.vent });
  assert.equal(job.status, 200);
  await until(async () => refOf(host(), job.body.thread), ref => ref !== undefined);
  assert.deepEqual(refOf(host(), job.body.thread), { agent: agents.vent, dir: ventDir(), role: "job" });
});

test("a folder reads by agent id, DM room, work thread and a job inside it, and the brief round-trips and deletes with empty text", async () => {
  const job = (await s.get<ConversationSummary[]>("/api/conversations")).find(c => c.id.startsWith(`${ids.vent}:`))!;
  for (const id of [agents.vent, "dm_vent", ids.vent, job.id]) assert.equal((await folder(id)).agent, agents.vent, id);
  const seeded = await folder(agents.vent);
  assert.equal(seeded.dir, ventDir());
  assert.match(seeded.brief.text, /canary relay/);
  assert.equal(seeded.brief.loaded, true);

  const text = "Own the canary relay.\n\n1. Page the owner only when a test window is lost.\n";
  const put = await s.send<AgentFolder>("PUT", `/api/agents/${ids.vent}/brief`, { text });
  assert.equal(put.status, 200);
  assert.equal(put.body.brief.text, text);
  assert.equal(readFileSync(join(ventDir(), "brief.md"), "utf8"), text);
  assert.equal((await folder("dm_vent")).brief.text, text);

  const cleared = await s.send<AgentFolder>("PUT", `/api/agents/${agents.vent}/brief`, { text: "" });
  assert.equal(cleared.status, 200);
  assert.deepEqual([cleared.body.brief.text, cleared.body.brief.exists, cleared.body.brief.loaded], ["", false, false]);
  assert.equal(existsSync(join(ventDir(), "brief.md")), false);

  assert.equal((await s.send("PUT", `/api/agents/${agents.vent}/brief`, { text: 3 })).status, 400);
  assert.equal((await s.send("GET", "/api/agents/ag_nobody/folder")).status, 404);
  assert.equal((await s.send("PUT", "/api/agents/ag_nobody/brief", { text: "x" })).status, 404);
});

test("memory create, update and delete write Prime's harness format, which Prime's reader loads back", async () => {
  const title = "Relay port moved to 7791, see p1128";
  const id = harnessSlug(title, "memory");
  assert.equal(id, "relay_port_moved_to_7791_see_p1128");

  const created = await s.send<AgentFolder>("POST", `/api/agents/${agents.vent}/memory`, { title, content: "The relay listens on 7791; 7790 is Prime's." });
  assert.equal(created.status, 200);
  const view = created.body.memory.entries.find(e => e.id === id);
  assert.equal(view?.source, "owner");
  assert.equal(view?.version, 1);
  assert.equal(created.body.memory.entries[0]?.id, id, "the newest entry comes first");
  assert.equal(created.body.memory.count, 2);

  const raw = readFileSync(storeFile(), "utf8");
  const parsed = JSON.parse(raw) as { schema: number; entries: Record<string, Record<string, Record<string, unknown>>>; refinements: unknown[] };
  assert.equal(raw, JSON.stringify(parsed, null, 2), "indent 2 and no trailing newline, as json.dump writes");
  assert.deepEqual(Object.keys(parsed), ["schema", "entries", "refinements"]);
  assert.deepEqual(Object.keys(parsed.entries), ["prompt", "memory", "skill", "subagent"]);
  const stored = parsed.entries.memory![id]!;
  assert.deepEqual(Object.keys(stored), ["id", "kind", "title", "content", "path", "scope", "reference", "arguments", "metadata", "source", "created_at", "updated_at", "version"]);
  assert.match(String(stored.created_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$/);
  assert.equal(statSync(storeFile()).mode & 0o777, 0o600);

  const loaded = loadHarnessState(join(ventDir(), "harness"), "local").entries.memory[id]!;
  assert.deepEqual(
    { id: loaded.id, kind: loaded.kind, title: loaded.title, path: loaded.path, scope: loaded.scope, source: loaded.source, version: loaded.version, reference: loaded.reference },
    { id, kind: "memory", title, path: "general", scope: "local", source: "owner", version: 1, reference: {} },
  );
  assert.ok(loadHarnessState(join(ventDir(), "harness"), "local").entries.memory.the_mac_sleeps_from_01_00_to_07_00_kst, "the seeded entry stays");

  const again = await s.send("POST", `/api/agents/${agents.vent}/memory`, { title, content: "Another text." });
  assert.equal(again.status, 409);

  await new Promise(resolve => setTimeout(resolve, 5));
  const updated = await s.send<AgentFolder>("PUT", `/api/agents/dm_vent/memory/${id}?kind=memory`, { title, content: "The relay listens on 7791." });
  assert.equal(updated.status, 200);
  const after1 = loadHarnessState(join(ventDir(), "harness"), "local").entries.memory[id]!;
  assert.equal(after1.content, "The relay listens on 7791.");
  assert.equal(after1.version, 2);
  assert.equal(after1.created_at, loaded.created_at);
  assert.ok(after1.updated_at > loaded.updated_at);
  assert.equal(after1.path, "general", "an update with no path keeps it");
  await s.send("PUT", `/api/agents/${agents.vent}/memory/${id}`, { title, content: "The relay listens on 7791.", path: "relay" });
  assert.equal(loadHarnessState(join(ventDir(), "harness"), "local").entries.memory[id]!.path, "relay");

  assert.equal((await s.send("POST", `/api/agents/${agents.vent}/memory`, { title: " ", content: "x" })).status, 400);
  assert.equal((await s.send("POST", `/api/agents/${agents.vent}/memory`, { title: "x", content: "x", path: "" })).status, 400);
  assert.equal((await s.send("PUT", `/api/agents/${agents.vent}/memory/${id}?kind=notes`, { title, content: "x" })).status, 400);
  assert.equal((await s.send("PUT", `/api/agents/${agents.vent}/memory/no_such_entry`, { title, content: "x" })).status, 404);

  const deleted = await s.send<AgentFolder>("DELETE", `/api/agents/${agents.vent}/memory/${id}?kind=memory`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.memory.entries.some(e => e.id === id), false);
  assert.equal(loadHarnessState(join(ventDir(), "harness"), "local").entries.memory[id], undefined);
  assert.equal((await s.send("DELETE", `/api/agents/${agents.vent}/memory/${id}`)).status, 404);
});

test("an agent's config carries its folder and memory kind agent, and a job of the agent shares them", async () => {
  const c = await s.get<AgentConfig>(`/api/agents/${agents.vent}/config`);
  assert.equal(c.folder?.agent, agents.vent);
  assert.equal(c.folder?.memory.path, storeFile());
  assert.equal(c.memory.kind, "agent");
  assert.ok(c.memory.related.some(f => f.label.includes("global") && f.loaded === true));
  const job = (await s.get<ConversationSummary[]>("/api/conversations")).find(conv => conv.id.startsWith(`${ids.vent}:`))!;
  const jc = await s.get<AgentConfig>(`/api/agents/${encodeURIComponent(job.id)}/config`);
  assert.equal(jc.folder?.dir, ventDir());
  assert.equal(jc.memory.kind, "agent");
});
