/**
 * The split migration's dry run (scripts/split-agents.ts) on the fixture world: it writes no file and no thread, and its plan names what the
 * split changes (the comm thread, both agent.refs, the tools, the feed switch, posts still sending), what stays and what runs now.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applySplit, dryRunAgents, readOnlyHost, renderReport, splitReport } from "../../scripts/split-agents.ts";
import { AgentStore } from "../../server/agent-store.ts";
import { DEFAULT_MODEL, fixtureFolders } from "../../server/config.ts";
import { FIXTURE_AGENTS, FIXTURE_IDS, seedFixture } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { start } from "./helpers.ts";

function files(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out.set(`${path}/`, "dir"));
    else out.set(path, createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  return out;
}

function hostState(host: FixtureHost): string {
  return JSON.stringify([...host.threadsById.values()].map(t => ({
    row: t.row, nodes: t.nodes, entries: t.entries.length, docs: [...t.docs], submissions: t.submissions.size, requests: [...t.byRequest],
  })));
}

function world() {
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-split-"));
  const host = new FixtureHost();
  host.wordMs = 0;
  seedFixture(host, dataDir);
  const store = new AgentStore(dataDir);
  const record = store.agentOf(FIXTURE_AGENTS.harness)!;
  store.append({
    room: record.room, author: "owner", text: "Is the cutover still on for Friday?", images: [], at: Date.now(), requestId: "split-test-sending",
    delivery: { target: record.id, state: "sending", attempts: 2, at: Date.now(), requestId: "d:p9:x" },
  });
  const agents = dryRunAgents(dataDir, host, { box: "test-box", agentsDir: fixtureFolders(dataDir).agentsDir });
  return { dataDir, host, agents, record: agents.record(FIXTURE_AGENTS.harness)!, close: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test("the dry run writes no file and no thread", async () => {
  const { dataDir, host, agents, close } = world();
  try {
    const before = { files: files(dataDir), host: hostState(host) };
    for (const record of agents.list()) renderReport(await splitReport(agents, record));
    assert.deepEqual(files(dataDir), before.files);
    assert.equal(hostState(host), before.host);
  } finally {
    close();
  }
});

test("an agent that already has its comm thread reads as split, with nothing to change", async () => {
  const { agents, record, close } = world();
  try {
    record.comm = { [record.room]: "comm-thread-1" };
    const report = await splitReport(agents, record);
    assert.deepEqual(report.plan.comm, { thread: "comm-thread-1", created: false });
    assert.match(renderReport(report), /Already split: comm thread comm-thread-1\. The split changes nothing\./);
  } finally {
    close();
  }
});

test("the read-only host refuses every write", async () => {
  const host = readOnlyHost(new FixtureHost());
  await assert.rejects(host.create({ name: "x" }), /refuses create/);
  await assert.rejects(host.submit(FIXTURE_IDS.vent, { text: "x" }), /refuses submit/);
  await assert.rejects(host.docPut(FIXTURE_IDS.vent, "agent.ref", {}), /refuses docPut/);
  await assert.rejects(host.set(FIXTURE_IDS.vent, { name: "x" }), /refuses set/);
  await assert.rejects(host.abort(FIXTURE_IDS.vent), /refuses abort/);
  assert.deepEqual(await host.threads(), []);
});

test("the plan names the comm thread, both refs, the tools, the feed switch, the posts sending, what stays and what runs", async () => {
  const { agents, record, close } = world();
  try {
    const report = await splitReport(agents, record);
    const { plan } = report;
    assert.ok(plan.comm.created);
    assert.deepEqual(plan.comm.create, { name: `${record.name} · DM`, model: DEFAULT_MODEL, thinkingLevel: "high", cwd: record.home });
    assert.equal(plan.commRef.role, "comm");
    assert.deepEqual(plan.commRef, { agent: record.id, dir: report.stays.folder.dir, role: "comm", room: record.room, work: record.workThread });
    assert.equal(plan.workRef.after.role, "work");
    assert.equal((plan.workRef.after as { comm?: string }).comm, "<new>");
    assert.deepEqual(report.feed.after, { thread: "<new>", entry: 0 });
    assert.equal(report.feed.drain.to, report.live.newestEntry);
    assert.deepEqual(report.sending.map(p => p.text), ["Is the cutover still on for Friday?"]);
    assert.deepEqual(report.stays.jobs.map(j => j.thread).sort(), [FIXTURE_IDS.cutover, FIXTURE_IDS.uptimeDuty].sort());
    assert.ok(report.stays.board && report.stays.board.steps > 0);
    assert.deepEqual(report.stays.duties.names, ["d1 Relay uptime", "d2 Search freshness"]);
    assert.equal(report.stays.duties.checkIn?.everyMs, 120 * 60_000);
    assert.deepEqual(report.live.children.map(c => c.name), ["Rerun the cross-box test on the canary relay"]);

    const text = renderReport(report);
    for (const part of [
      `"${record.name} · DM" with ${DEFAULT_MODEL}, thinking high, cwd ${record.home}`,
      "work thread loses the tools tell_owner, and gets these instructions",
      "comm thread loses the tools write, edit, bash, subagent and is offered stop_work",
      `You are agent ${record.id}'s comm thread in room ${record.room}.`,
      `You are agent ${record.id}'s work thread.`,
      "then the comm thread from entry 0",
      "Is the cutover still on for Friday?",
      `keeps its id ${record.workThread}`,
      "Stays as it is",
      "Duties and the check-in stay",
      "Live in the work thread now",
    ]) assert.ok(text.includes(part), `the report names ${part}:\n${text}`);
  } finally {
    close();
  }
});

test("--apply splits each agent through the server's route, and a second run finds it split", async () => {
  const s = await start();
  try {
    const lines: string[] = [];
    await applySplit(s.base, [FIXTURE_AGENTS.vent, "ag_nobody"], line => lines.push(line));
    const comm = s.app.agents.record(FIXTURE_AGENTS.vent)!.comm?.dm_vent;
    assert.ok(comm);
    assert.equal(lines[0], `${FIXTURE_AGENTS.vent}: split, comm thread ${comm}`);
    assert.match(lines[1]!, /^ag_nobody: refused with HTTP 404/);
    await applySplit(s.base, [FIXTURE_AGENTS.vent], line => lines.push(line));
    assert.equal(lines[2], `${FIXTURE_AGENTS.vent}: already split, comm thread ${comm}`);
  } finally {
    await s.close();
  }
});
