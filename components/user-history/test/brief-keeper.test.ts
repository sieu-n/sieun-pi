import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRIEFS_DIR, briefAct, type BriefRecord, briefTick, primeWorkers, restartText, seeBrief, type TreeWorker, unstartedJobs, withUnstarted } from "../src/brief-keeper.ts";
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
  assert.deepEqual(await seeBrief(lost.record), { sessionId: "01a14200-ca11-702a-99db-06c502bc7527", file: lost.file, started: false, prompted: false, ended: false });
  assert.equal((await seeBrief(started.record)).started, true);
  const deleted = await child(await mkdtemp(join(tmpdir(), "brief-see-")), fixture.postReads, "deleted");
  assert.equal((await seeBrief(deleted.record)).ended, true, "a child its parent deleted is not sent anything");
});

test("the keeper sends a late brief whatever dropped it, unless the tree's live worker ran the session, and once to each worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "brief-act-"));
  const { record } = await child(root, fixture.opensearch);
  const seen = await seeBrief(record);
  const at = (ms: number) => record.at + ms;
  const w1: TreeWorker = { id: "w1", ran: false };
  assert.deepEqual(briefAct(record, seen, w1, at(60_000)), { act: "wait" }, "inside p99 of first-prompt times");
  // 10-16 06:03Z: lim-infra's worker journal had its agent_start 16 s after the spawn while its file held 5 lines at 06:14Z.
  assert.deepEqual(briefAct(record, seen, { id: "w1", ran: true }, at(11 * 60_000)), { act: "wait" }, "the live worker ran it, so only the file is late");
  // 10-15 14:35:39Z: every worker got SIGTERM while the supervisor ran on, and the tree's next worker never ran the child.
  assert.deepEqual(briefAct(record, seen, { id: "w2", ran: false }, at(11 * 60_000)), { act: "send", session: seen.sessionId }, "a worker stop under a live supervisor");
  assert.deepEqual(briefAct(record, seen, undefined, RESTART + 30_000), { act: "send", session: seen.sessionId }, "no worker runs the tree");
  assert.deepEqual(briefAct(record, seen, w1, at(6 * 60_000)), { act: "send", session: seen.sessionId }, "the spawn's own worker lost the send");
  const sent = { ...record, sent: { at: at(6 * 60_000), worker: "w1" } };
  assert.deepEqual(briefAct(sent, seen, w1, at(60 * 60_000)), { act: "wait" }, "sent once to this worker");
  assert.deepEqual(briefAct(sent, seen, { id: "w3", ran: false }, at(60 * 60_000)), { act: "send", session: seen.sessionId }, "a later worker lost the copy");
  assert.deepEqual(briefAct(sent, { ...seen, started: true }, { id: "w3", ran: false }, at(60 * 60_000)), { act: "drop", why: "started" });
});

test("a child whose file shows a later message but not its task lost the brief, even though its worker ran it", async () => {
  const root = await mkdtemp(join(tmpdir(), "brief-later-"));
  const { file, record } = await child(root, fixture.opensearch);
  // 10-16 03:39Z: "duty prompt button" never got its task, and a check-in nudge became the first prompt in its file.
  await appendFile(file, JSON.stringify({ type: "custom_message", customType: "agent_message", content: "[agent-message from parent:Crawler VP]\n\nThe check-in is checking on you",
    timestamp: new Date(record.at + 20 * 60_000).toISOString() }) + "\n");
  const seen = await seeBrief(record);
  assert.deepEqual([seen.started, seen.prompted], [false, true], "a message from the parent is not the task");
  assert.deepEqual(briefAct(record, seen, { id: "w1", ran: true }, record.at + 21 * 60_000), { act: "send", session: seen.sessionId });
  const data = join(root, BRIEFS_DIR);
  await mkdir(data, { recursive: true });
  await writeFile(join(data, `child-${record.id}.json`), JSON.stringify(record));
  assert.deepEqual((await unstartedJobs(data, record.at + 21 * 60_000, async () => ({ id: "w1", ran: true }))).map(job => job.key), [record.id], "the check-in reads it as not started");
});

/** A Prime agent dir with one worker file per tree and its recovery journal, as Prime 0.9.8 writes them. */
async function workersDir(entries: { id: string; root: string; pid: number; createdAt: string; journal: object[] }[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "brief-workers-"));
  await mkdir(join(dir, "bab13329a1b8"), { recursive: true });
  for (const entry of entries) {
    const journal = join(dir, "bab13329a1b8", `${entry.id}.recovery.jsonl`);
    await writeFile(journal, entry.journal.map(line => JSON.stringify(line)).join("\n") + "\n");
    await writeFile(join(dir, "bab13329a1b8", `${entry.id}.json`), JSON.stringify({ version: 2, workerId: entry.id, pid: entry.pid, recoveryJournalPath: journal,
      rootSessionId: entry.root, createdAt: entry.createdAt, lifecycle: "ready" }, null, 2));
  }
  return dir;
}
const op = (session: string, operation: string, recordedAt: string) => ({ version: 1, activeSessionId: "9c9eba054326", sessionId: session, busy: operation !== "ready", operation, recordedAt });

test("primeWorkers finds the tree's live worker and reads its journal: an agent_start since that worker began means the session ran", async () => {
  const session = "01a14200-ca11-702a-99db-06c502bc7527";
  const dead = spawnSync("true").pid!;
  const dir = await workersDir([
    { id: "aaaaaaaaaaaa", root: CHAT, pid: dead, createdAt: "2026-10-15T14:00:00.000Z", journal: [op(session, "agent_start", "2026-10-15T14:20:00.000Z")] },
    { id: "bbbbbbbbbbbb", root: "01a10000-0000-7000-8000-000000000000", pid: process.pid, createdAt: "2026-10-15T14:00:00.000Z", journal: [op(session, "agent_start", "2026-10-15T14:20:00.000Z")] },
  ]);
  const read = primeWorkers(dir);
  assert.equal(await read(CHAT, session), undefined, "the worker that ran it is gone and no other runs the tree");
  const live = await workersDir([{ id: "cccccccccccc", root: CHAT, pid: process.pid, createdAt: "2026-10-15T14:36:00.000Z",
    journal: [op(session, "agent_start", "2026-10-15T14:20:00.000Z"), op(session, "ready", "2026-10-15T14:36:05.000Z")] }]);
  assert.deepEqual(await primeWorkers(live)(CHAT, session), { id: "cccccccccccc", ran: false }, "an agent_start from before this worker began is the dead worker's");
  const ran = await workersDir([{ id: "dddddddddddd", root: CHAT, pid: process.pid, createdAt: "2026-10-16T06:00:00.000Z",
    journal: [op(session, "ready", "2026-10-16T06:03:53.000Z"), op(session, "agent_start", "2026-10-16T06:03:59.000Z")] }]);
  assert.deepEqual(await primeWorkers(ran)(CHAT, session), { id: "dddddddddddd", ran: true });
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
  const deps = { dir: data, worker: async () => (resident ? { id: "w2", ran: false } : undefined), log: () => {}, startRoot: async (id: string) => { roots.push(id); resident = true; },
    deliver: async (session: string, text: string) => { if (!resident) return "gone" as const; sends.push([session, text]); return "sent" as const; } };
  const now = RESTART + 60_000;
  assert.equal(await briefTick({ ...deps, now: () => now }), 0);
  assert.deepEqual(roots, [CHAT], "the daemon did not find the child after the restart, so its tree starts");
  assert.equal(await briefTick({ ...deps, now: () => now + 30_000 }), 1);
  assert.equal(sends[0]![0], "01a14200-ca11-702a-99db-06c502bc7527");
  assert.ok(sends[0]![1].startsWith("[task from parent]\n\nOwner's words (verbatim, 10-16 about 00:01Z)"), "the child gets its brief as Prime labels a task");
  assert.match(sends[0]![1], /started this session at 10-15 23:58Z and its first prompt never reached it/);
  assert.equal(await briefTick({ ...deps, now: () => now + 60_000 }), 0, "sent once to this worker");
  assert.equal((await unstartedJobs(data, now + 60_000, deps.worker)).length, 1, "still not started until its file shows the prompt");
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
  // At 00:29Z the 00:20:13Z restart had dropped its worker, and the tree's new worker never ran the child.
  const fresh = async () => ({ id: "w2", ran: false });
  const facts = withUnstarted(before, await unstartedJobs(data, now, fresh));
  assert.equal(facts[0]!.state, "unstarted");
  const end = endState(stepView(item, now - 26 * 60_000, self, facts, [], [], now), [], [], self, now, facts);
  assert.equal(end.state, "job_ended");
  assert.equal(end.reason, "job post reads schema fix never started: Prime admitted it at 10-16 00:03Z and its session has no first prompt");
  assert.deepEqual(withUnstarted(before, await unstartedJobs(data, record.at + 60_000, fresh)), before, "inside the measured start time it is left alone");
  assert.deepEqual(await unstartedJobs(data, now, async () => ({ id: "w1", ran: true })), [], "a job its live worker ran started; only its file is late");
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

test("a child whose worker died before Prime wrote anything for it is started again once, as a root job of its chat", async () => {
  // Clean-room run 6, 10-17 21:29:46Z: kill-worker SIGKILLed the chat's worker 67 ms after rlm.spawn returned, and the child's folder stayed empty.
  const root = await mkdtemp(join(tmpdir(), "brief-unborn-"));
  const sessionDir = join(root, "session-artifacts", CHAT, "sub-d3c04872");
  await mkdir(sessionDir, { recursive: true });
  const data = join(root, BRIEFS_DIR);
  await mkdir(data, { recursive: true });
  const record: BriefRecord = { kind: "child", id: "sub-d3c04872", name: "user history file count", prompt: "count the .ts files; reply to your parent", at: Date.parse("2026-10-17T21:29:46.745Z"), root: CHAT, sessionDir };
  await writeFile(join(data, `child-${record.id}.json`), JSON.stringify(record));
  const seen = await seeBrief(record);
  assert.equal(seen.unborn, true);
  assert.deepEqual(briefAct(record, seen, undefined, record.at + 60_000), { act: "wait" }, "inside the start time Prime may still write it");
  assert.deepEqual(briefAct(record, seen, undefined, record.at + 5 * 60_000), { act: "restart" });
  const started: [string, string][] = [];
  const deps = { dir: data, worker: async () => undefined, log: () => {}, startRoot: async () => {}, deliver: async () => "sent" as const,
    restart: async (r: BriefRecord, text: (chat: string) => string) => { started.push([r.name, text("user-history ts sum")]); return "01a14bd0-0000-7000-8000-000000000000"; } };
  assert.equal(await briefTick({ ...deps, now: () => record.at + 5 * 60_000 + 1 }), 1);
  assert.equal(started.length, 1);
  assert.equal(started[0]![0], "user history file count");
  assert.ok(started[0]![1].startsWith("count the .ts files; reply to your parent\n\n(The chat service started this job at 10-17 21:34Z"));
  assert.match(started[0]![1], /receiver_role="sibling", receiver_name="user-history ts sum"/);
  assert.deepEqual(await readdir(data), [], "restarted once: the record is gone");
  await writeFile(join(sessionDir, "rlm-subagent.json"), JSON.stringify({ status: "running" }));
  assert.equal((await seeBrief(record)).unborn, undefined, "a child Prime admitted is not restarted");
  assert.equal(restartText(record, "c", 0).includes("in place of \"user history file count\""), true);
});
