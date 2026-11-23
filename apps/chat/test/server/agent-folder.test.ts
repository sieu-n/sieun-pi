/**
 * The agent folder on the fixture host (apps/chat/docs/agent-model.md, phase 3): the agent.ref sweep, the brief and memory routes, the
 * harness store in Prime's on-disk format as pi-host's copy of Prime's reader loads it, and the config's folder and memory kind.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agent-folder.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentConfig, AgentFolder, AgentSummary, ConversationSummary } from "../../web/src/lib/api/types.ts";
import { AGENT_REF_DOC, harnessSlug } from "../../server/agent-folder.ts";
import { drained } from "../../server/disk.ts";
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

test("the sweep writes agent.ref into each work thread and root job thread once, and a second server's sweep reads and writes nothing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-refs-"));
  const first = await start({ dataDir });
  try {
    const h = first.host as FixtureHost;
    const dirOf = (slug: string) => join(first.app.config.agentsDir, slug);
    await until(async () => refOf(h, ids.uptimeDuty), ref => ref !== undefined);
    const dmComm = (agent: string) => { const record = first.app.agents.record(agent)!; return record.comm![record.room]!; };
    assert.deepEqual(refOf(h, ids.vent), { agent: agents.vent, dir: dirOf("vent"), role: "work", comm: dmComm(agents.vent) });
    assert.deepEqual(refOf(h, ids.harness), { agent: agents.harness, dir: dirOf("ai-harness-developer-environment-vp"), role: "work", comm: dmComm(agents.harness) });
    assert.deepEqual(refOf(h, ids.crawler), { agent: agents.crawler, dir: dirOf("crawler-vp"), role: "work", comm: dmComm(agents.crawler) },
      "the server made Crawler VP's DM comm thread beside its #pi-cutover one, and its work thread names the DM's");
    assert.deepEqual(refOf(h, ids.cutover), { agent: agents.harness, dir: dirOf("ai-harness-developer-environment-vp"), role: "job" });
    assert.deepEqual(refOf(h, ids.uptimeDuty), { agent: agents.harness, dir: dirOf("ai-harness-developer-environment-vp"), role: "job" });

    await first.app.agents.sweepRefs();
    // A second sweep, since the first call may join one that began before the last comm thread's ref landed.
    await first.app.agents.sweepRefs();
    // The sweep keeps the refs it read or wrote in <data dir>/cache/agent-refs.json for the next start.
    await drained();
    const puts: string[] = [];
    let gets = 0;
    const put = h.docPut.bind(h);
    const get = h.docGet.bind(h);
    h.docPut = async (thread, name, value) => {
      puts.push(thread);
      return put(thread, name, value);
    };
    const reads: string[] = [];
    h.docGet = async (thread, name) => {
      gets += 1;
      reads.push(`${thread}/${name}`);
      return get(thread, name);
    };
    const second = await start({ dataDir, host: h });
    try {
      await second.app.agents.sweepRefs();
      assert.equal(gets, 0, `the second server found every ref in the first one's cache (it read ${gets}: ${reads.join(", ")})`);
      assert.deepEqual(puts, [], "every ref was already there");

      // A thread whose agent moved to another box reads its ref again there.
      const vent = second.app.agents.record(agents.vent)!;
      const box = vent.host;
      vent.host = "another-box";
      reads.length = 0;
      await second.app.agents.sweepRefs();
      vent.host = box;
      await second.app.agents.sweepRefs();
      assert.ok(reads.includes(`${ids.vent}/${AGENT_REF_DOC}`), `the moved agent's work thread is read again: ${reads.join(", ")}`);

      // A ref that vanishes inside pi-host behind the cache comes back on the background check, and a changed one is put right.
      h.docGet = get;
      const ventRef = refOf(h, ids.vent);
      const harnessRef = refOf(h, ids.harness);
      h.threadsById.get(ids.vent)!.docs.delete(AGENT_REF_DOC);
      await put(ids.harness, AGENT_REF_DOC, { ...(harnessRef as object), role: "job" });
      second.app.agents.verifyGapMs = 1;
      await second.app.agents.verifyRefs();
      assert.deepEqual(refOf(h, ids.vent), ventRef);
      assert.deepEqual(refOf(h, ids.harness), harnessRef);
      assert.deepEqual([...new Set(puts)].sort(), [ids.harness, ids.vent].sort());
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
  await s.app.ensureComms();
  const comm = s.app.agents.record("ag_ref-probe")!.comm!["dm_ref-probe"];
  assert.ok(comm, "its DM's comm thread, made with no post");
  assert.deepEqual(refOf(host(), made.body.thread), { agent: "ag_ref-probe", dir: join(s.app.config.agentsDir, "ref-probe"), role: "work", comm });

  const job = await s.send<AgentSummary>("POST", "/api/agents", { name: "Ref probe job", kind: "job", parent: agents.vent });
  assert.equal(job.status, 200);
  await until(async () => refOf(host(), job.body.thread), ref => ref !== undefined);
  assert.deepEqual(refOf(host(), job.body.thread), { agent: agents.vent, dir: ventDir(), role: "job" });
});

test("a new agent's first agent.ref write that lands late leaves its work thread's ref naming the comm thread", async () => {
  const docPut = host().docPut.bind(host());
  let release!: () => void;
  const held = new Promise<void>(resolve => (release = resolve));
  let holding = true;
  host().docPut = async (id, name, value, opts) => {
    if (name === AGENT_REF_DOC && holding && (value as { agent?: string }).agent === "ag_late-ref-probe") {
      holding = false;
      await held;
    }
    return docPut(id, name, value, opts);
  };
  try {
    const made = await s.send<AgentSummary>("POST", "/api/agents", { name: "Late ref probe" });
    assert.equal(made.status, 200);
    const ensured = s.app.ensureComms();
    await sleep(100);
    release();
    await ensured;
    await until(async () => s.app.agents.refWritten(made.body.thread), wrote => wrote);
    const comm = s.app.agents.record("ag_late-ref-probe")!.comm!["dm_late-ref-probe"];
    assert.ok(comm);
    assert.equal((refOf(host(), made.body.thread) as { comm?: string } | undefined)?.comm, comm);
  } finally {
    release();
    host().docPut = docPut;
  }
});

test("POST /api/agents answers while the new thread's agent.ref write waits, and a send right after it reaches pi-host once the ref lands", async () => {
  // Until 11-23 the answer waited for the ref write, two pi-host round trips, and a thread list read that answered meanwhile held the
  // event loop before the answer went out: the create's handler took p50 476 ms and p90 1,039 ms over 422 calls.
  const docPut = host().docPut.bind(host());
  let release!: () => void;
  const held = new Promise<void>(resolve => (release = resolve));
  host().docPut = async (id, name, value) => {
    if (name === AGENT_REF_DOC) await held;
    return docPut(id, name, value);
  };
  const submits: { thread: string; role?: string }[] = [];
  host().beforeSubmit = thread => {
    submits.push({ thread, role: (refOf(host(), thread) as { role?: string } | undefined)?.role });
  };
  const answered = <T>(call: Promise<T>) => Promise.race([call, sleep(5000).then(() => "no answer while the ref write waits" as const)]);
  try {
    const made = await answered(s.send<AgentSummary>("POST", "/api/agents", { name: "Slow ref probe" }));
    assert.ok(typeof made !== "string", made as string);
    assert.equal(made.status, 200);
    assert.equal(refOf(host(), made.body.thread), undefined, "the ref write still waits");
    const job = await answered(s.send<AgentSummary>("POST", "/api/agents", { name: "Slow ref probe job", kind: "job", parent: agents.vent }));
    assert.ok(typeof job !== "string", job as string);
    assert.equal(job.status, 200);

    for (const [i, thread] of [made.body.thread, job.body.thread].entries()) {
      const sent = await s.send("POST", `/api/c/${thread}/send`, { requestId: `slow-ref-${i}`, text: "What is your name?" });
      assert.equal(sent.status, 200);
    }
    await sleep(300);
    assert.deepEqual(submits.filter(x => x.thread === made.body.thread || x.thread === job.body.thread), [], "no send reaches pi-host before its thread's ref");
    release();
    await until(async () => submits.filter(x => x.thread === made.body.thread || x.thread === job.body.thread).length, n => n === 2);
    assert.equal(submits.find(x => x.thread === made.body.thread)?.role, "work");
    assert.equal(submits.find(x => x.thread === job.body.thread)?.role, "job");
  } finally {
    release();
    host().docPut = docPut;
    host().beforeSubmit = undefined;
  }
});

test("a new agent's brief from the create form lands in its brief.md, a blank one writes none, and a brief that is no string is refused", async () => {
  const words = "Keep the llm-wiki info and the skills always up to date.";
  const made = await s.send<AgentSummary>("POST", "/api/agents", { name: "Brief probe", brief: `  ${words}\n` });
  assert.equal(made.status, 200);
  assert.equal(readFileSync(join(s.app.config.agentsDir, "brief-probe", "brief.md"), "utf8"), words);
  const view = await folder(made.body.id);
  assert.deepEqual([view.brief.text, view.brief.loaded], [words, true]);

  const blank = await s.send<AgentSummary>("POST", "/api/agents", { name: "Blank brief probe", brief: "  " });
  assert.equal(blank.status, 200);
  assert.equal(existsSync(join(s.app.config.agentsDir, "blank-brief-probe", "brief.md")), false);

  const refused = await s.send<{ error: string }>("POST", "/api/agents", { name: "Bad brief probe", brief: 7 });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /brief is text/);
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

test("the working memory reads as empty with no file, round-trips through its PUT, shows in the config, and deletes with empty text", async () => {
  const path = join(ventDir(), "working-memory.md");
  rmSync(path, { force: true });
  const empty = await folder(agents.vent);
  assert.deepEqual([empty.workingMemory.text, empty.workingMemory.exists, empty.workingMemory.loaded, empty.workingMemory.path], ["", false, false, path]);

  const text = "# Working on\n\n- The relay page shows Mac uptime; waiting on the Mac relay.\n";
  const put = await s.send<AgentFolder>("PUT", `/api/agents/dm_vent/working-memory`, { text });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.workingMemory.text, put.body.workingMemory.loaded], [text, true]);
  assert.equal(readFileSync(path, "utf8"), text);
  assert.equal((await s.get<AgentConfig>(`/api/agents/${agents.vent}/config`)).folder?.workingMemory.text, text);

  const cleared = await s.send<AgentFolder>("PUT", `/api/agents/${agents.vent}/working-memory`, { text: " " });
  assert.deepEqual([cleared.body.workingMemory.text, cleared.body.workingMemory.exists], ["", false]);
  assert.equal(existsSync(path), false);
  assert.equal((await s.send("PUT", `/api/agents/${agents.vent}/working-memory`, { text: null })).status, 400);
  assert.equal((await s.send("PUT", "/api/agents/ag_nobody/working-memory", { text: "x" })).status, 404);
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
  assert.equal(raw, JSON.stringify(parsed, null, 2) + "\n", "indent 2 and one trailing newline, as pi-harness's writeState writes");
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

test("a memory write waits while a pi-harness writer in another process holds the store's lock, so both writers' entries stay", async () => {
  const dir = join(ventDir(), "harness");
  const go = join(dir, "race.go");
  // The other writer, as a kernel or refine is: it takes the lock, adds its entry, and keeps the lock until the test writes `go`.
  const script = `
    import { existsSync, writeSync } from "node:fs";
    const { updateState } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../../../../packages/pi-harness/src/core/store.ts", import.meta.url))).href)});
    await updateState(${JSON.stringify(dir)}, "local", state => {
      state.entries.memory.kernel_side = { id: "kernel_side", kind: "memory", title: "Kernel side", content: "x", path: "general", scope: "local", reference: {}, arguments: {}, metadata: {}, source: "agent", created_at: "", updated_at: "", version: 1 };
      writeSync(1, "locked\\n");
      while (!existsSync(${JSON.stringify(go)}));
    });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await once(child.stdout!, "data");
    const post = s.send<AgentFolder>("POST", `/api/agents/${agents.vent}/memory`, { title: "Route side", content: "y" });
    // An unlocked write answers in a few ms, so it lands inside these 300 ms and the other writer then replaces the file without it.
    await Promise.race([post, sleep(300)]);
    writeFileSync(go, "");
    const [created, [exitCode]] = await Promise.all([post, once(child, "exit")]);
    assert.equal(created.status, 200);
    assert.equal(exitCode, 0);
    const memory = loadHarnessState(dir, "local").entries.memory;
    assert.ok(memory.kernel_side, "the other writer's entry stays");
    assert.ok(memory.route_side, "the route's entry stays");
  } finally {
    child.kill();
    rmSync(go, { force: true });
  }
  for (const entry of ["kernel_side", "route_side"]) await s.send("DELETE", `/api/agents/${agents.vent}/memory/${entry}?kind=memory`);
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
