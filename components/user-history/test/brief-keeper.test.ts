import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRIEF_LATE_MS, BRIEFS_DIR, briefAct, type BriefRecord, briefTick, seeBrief, unstartedJobs, withUnstarted } from "../src/brief-keeper.ts";
import { endState } from "../src/checkin-end-state.ts";
import { jobFacts, stepView } from "../src/checkin-steps.ts";
import { messageCheckPrelude } from "../src/message-limit-check.ts";
import type { ChildAgent, PlanItem } from "../src/shared/types.ts";
import fixture from "./fixtures/brief-lost-1016.json" with { type: "json" };

/*
 * Crawler VP, 10-15/16. Prime admitted "opensearch disk move" at 23:58:30Z and "post reads schema fix" at 00:03:27Z; each session file got its
 * 5 header lines and no first prompt, the supervisor restart at 00:20:13Z dropped the prompts Prime held in memory, and the 00:29Z check-in read
 * "post reads schema fix" as working. These replay those files.
 */
type Case = (typeof fixture)["opensearch"];
const CHAT = fixture.chat;
const RESTART = Date.parse(fixture.supervisorRestart);

/** A copy of one replayed child: its folder with rlm-subagent.json (status running, as Prime left it) and its session file. */
async function child(root: string, entry: Case, status = "running"): Promise<{ dir: string; file: string; record: BriefRecord }> {
  const dir = join(root, "session-artifacts", CHAT, entry.childId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, entry.sessionFile);
  await writeFile(file, entry.lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  await writeFile(join(dir, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", childId: entry.childId, sessionName: entry.sessionName, sessionDir: dir,
    sessionFile: file, prompt: entry.prompt, status, createdAt: entry.createdAt }));
  return { dir, file, record: { kind: "child", id: entry.childId, name: entry.sessionName, prompt: entry.prompt, at: entry.createdAt, root: CHAT, sessionDir: dir } };
}

test("a session with only its 5 header lines has no first prompt; one whose task landed has", async () => {
  const root = await mkdtemp(join(tmpdir(), "brief-see-"));
  const lost = await child(root, fixture.opensearch);
  const started = await child(root, fixture.crawlerLogs);
  assert.deepEqual(await seeBrief(lost.record), { sessionId: "01a14200-ca11-702a-99db-06c502bc7527", file: lost.file, started: false, ended: false });
  assert.equal((await seeBrief(started.record)).started, true);
  const deleted = await child(await mkdtemp(join(tmpdir(), "brief-see-")), fixture.postReads, "deleted");
  assert.equal((await seeBrief(deleted.record)).ended, true, "a child its parent deleted is not sent anything");
});

test("the keeper waits out the measured start time, sends the brief once per daemon, and sends it again after a supervisor restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "brief-act-"));
  const { record } = await child(root, fixture.opensearch);
  const seen = await seeBrief(record);
  const at = (ms: number) => record.at + ms;
  assert.deepEqual(briefAct(record, seen, "d1", at(60_000)), { act: "wait" }, "inside p99 of first-prompt times");
  assert.deepEqual(briefAct(record, seen, "d1", at(BRIEF_LATE_MS)), { act: "send", session: seen.sessionId });
  const sent = { ...record, sent: { at: at(BRIEF_LATE_MS), daemon: "d1" } };
  assert.deepEqual(briefAct(sent, seen, "d1", RESTART - 1000), { act: "wait" }, "the copy still waits in the same daemon");
  assert.deepEqual(briefAct(sent, seen, "d2", RESTART + 30_000), { act: "send", session: seen.sessionId }, "the 00:20:13Z restart dropped it");
  assert.deepEqual(briefAct(sent, { ...seen, started: true }, "d2", RESTART + 30_000), { act: "drop", why: "started" });
});

test("one tick replays the lost start: gone starts its tree, the next tick sends the brief, and the record goes once the prompt landed", async () => {
  const root = await mkdtemp(join(tmpdir(), "brief-tick-"));
  const data = join(root, "data", BRIEFS_DIR);
  await mkdir(data, { recursive: true });
  const { record, file } = await child(root, fixture.opensearch);
  await writeFile(join(data, `child-${record.id}.json`), JSON.stringify(record));
  const sends: [string, string][] = [];
  const roots: string[] = [];
  let resident = false;
  const deps = { dir: data, daemonEpoch: async () => "d2", log: () => {}, startRoot: async (id: string) => { roots.push(id); resident = true; },
    deliver: async (session: string, text: string) => { if (!resident) return "gone" as const; sends.push([session, text]); return "sent" as const; } };
  const now = RESTART + 60_000;
  assert.equal(await briefTick({ ...deps, now: () => now }), 0);
  assert.deepEqual(roots, [CHAT], "the daemon did not find the child after the restart, so its tree starts");
  assert.equal(await briefTick({ ...deps, now: () => now + 30_000 }), 1);
  assert.equal(sends[0]![0], "01a14200-ca11-702a-99db-06c502bc7527");
  assert.ok(sends[0]![1].startsWith("[task from parent]\n\nOwner's words (verbatim, 10-16 about 00:01Z)"), "the child gets its brief as Prime labels a task");
  assert.match(sends[0]![1], /started this session at 10-15 23:58Z and its first prompt never reached it/);
  assert.equal(await briefTick({ ...deps, now: () => now + 60_000 }), 0, "sent once to this daemon");
  assert.equal((await unstartedJobs(data, now + 60_000)).length, 1, "still not started until its file shows the prompt");
  await appendFile(file, JSON.stringify({ type: "custom_message", customType: "agent_message", content: sends[0]![1], timestamp: new Date(now + 61_000).toISOString() }) + "\n");
  assert.equal(await briefTick({ ...deps, now: () => now + 90_000 }), 0);
  assert.deepEqual(await readdir(data), [], "started: the record is dropped");
});

test("the check-in reads an admitted child with no first prompt as not started and its step as stuck, never as working", async () => {
  const root = await mkdtemp(join(tmpdir(), "brief-checkin-"));
  const data = join(root, BRIEFS_DIR);
  await mkdir(data, { recursive: true });
  const { record } = await child(root, fixture.postReads);
  await writeFile(join(data, `child-${record.id}.json`), JSON.stringify(record));
  const now = Date.parse("2026-10-16T00:29:30Z");
  // The daemon listed it as Prime left it: status running, so childWorking() was true.
  const children: ChildAgent[] = [{ id: record.id, sessionName: record.name, label: record.name, status: "running", lastActivityAt: record.at }];
  const item: PlanItem = { id: "p542", text: "post reads schema fix lands", status: "doing", job: record.name, children: [] };
  const self = new Set([CHAT, "Crawler VP"]);
  const before = jobFacts(children, null, [], CHAT);
  assert.equal(before[0]!.state, "working", "the old reading");
  const facts = withUnstarted(before, await unstartedJobs(data, now));
  assert.equal(facts[0]!.state, "unstarted");
  const end = endState(stepView(item, now - 26 * 60_000, self, facts, [], [], now), [], [], self, now, facts);
  assert.equal(end.state, "job_ended");
  assert.equal(end.reason, "job post reads schema fix never started: Prime admitted it at 10-16 00:03Z and its session has no first prompt");
  assert.deepEqual(withUnstarted(before, await unstartedJobs(data, record.at + 60_000)), before, "inside the measured start time it is left alone");
});

/** A kernel with the wrapper over a fake rlm: the host answers like Prime 0.9.8, and fleet-state.json says closed, which the old wrapper held on. */
const CS = "create" + "_session";
async function kernel(): Promise<{ run: ReturnType<typeof spawnSync>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "brief-kernel-"));
  await writeFile(join(dir, "fleet-state.json"), JSON.stringify({ at: Date.now(), closed: "the Prime workers hold 21.7 GB (budget 16 GB)" }));
  const art = join(dir, "session-artifacts", CHAT, "sub-aede9b4e");
  await writeFile(join(dir, "rlm.py"), [
    "sent = []",
    "class repl:",
    "    @staticmethod",
    "    def emit(data): pass",
    "async def host_request(request_type, payload=None):",
    "    sent.append(request_type)",
    `    if request_type == 'rlm.run': return {'rlm_child_id': 'sub-aede9b4e', 'name': payload['kwargs']['name'], 'session_dir': ${JSON.stringify(art)}, 'model': 'm'}`,
    "    return {'active_session_id': '01a1422b-0000-7000-8000-000000000001', 'session_id': '01a1422b-0000-7000-8000-000000000001', 'name': payload['kwargs']['name'], 'session_file': '/s/01a1422b-0000-7000-8000-000000000001.jsonl', 'model': 'm'}",
    "async def spawn(prompt, name):",
    "    return await host_request('rlm.run', {'prompt': prompt, 'kwargs': {'name': name}})",
    `async def ${CS}(prompt, name=None):`,
    `    return await host_request('rlm.${CS}', {'prompt': prompt, 'kwargs': {'name': name}})`,
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  const script = messageCheckPrelude(dir) + [
    "import asyncio, json, rlm",
    "async def main():",
    "    child = await rlm.spawn('move opensearch', name='opensearch disk move')",
    `    root = await rlm.${CS}('heal ig posts', name='ig posts heal fix')`,
    "    print(json.dumps({'child': child['rlm_child_id'], 'root': root['session_id'][:8], 'sent': rlm.sent}))",
    "asyncio.run(main())",
  ].join("\n");
  return { run: spawnSync("python3", ["-c", script], { cwd: dir, env: { ...process.env, PYTHONPATH: dir }, encoding: "utf8" }), dir };
}

test("the kernel sends both starts at once and records each brief for the keeper", async () => {
  const { run, dir } = await kernel();
  assert.equal(run.status, 0, String(run.stderr));
  assert.deepEqual(JSON.parse(String(run.stdout).trim().split("\n").at(-1)!), { child: "sub-aede9b4e", root: "01a1422b", sent: ["rlm.run", `rlm.${CS}`] },
    "no start is queued in the kernel, where it died with the kernel of the 00:29Z check-in");
  const names = (await readdir(join(dir, BRIEFS_DIR))).sort();
  assert.deepEqual(names, ["child-sub-aede9b4e.json", "root-01a1422b-0000-7000-8000-000000000001.json"]);
  const childRecord = JSON.parse(await readFile(join(dir, BRIEFS_DIR, names[0]!), "utf8"));
  assert.equal(childRecord.prompt, "move opensearch");
  assert.equal(childRecord.root, CHAT);
  const rootRecord = JSON.parse(await readFile(join(dir, BRIEFS_DIR, names[1]!), "utf8"));
  assert.deepEqual([rootRecord.kind, rootRecord.name, rootRecord.root, rootRecord.sessionFile], ["root", "ig posts heal fix", rootRecord.id, "/s/01a1422b-0000-7000-8000-000000000001.jsonl"]);
});
