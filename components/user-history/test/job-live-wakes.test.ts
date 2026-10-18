import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentLines, withWaits } from "../src/chat-agents.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { checkInRecord } from "../src/chat-checkin.ts";
import { type ChatThreads, type CheckInSource } from "../src/chat-sources.ts";
import { jobPushes } from "../src/checkin-jobs.ts";
import { withWakes } from "../src/checkin-load.ts";
import { checkInSettings, clockTime } from "../src/checkin-settings.ts";
import { type JobFact, jobFacts } from "../src/checkin-steps.ts";
import { Chats, NO_REPORT_BUSY_TRIES, withLiveRoster } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { JOB_NOTICE_PREFIX } from "../src/shared/chat-feed.ts";
import type { ChatAgent, ChatBoard, ChildAgent, PlanItem } from "../src/shared/types.ts";
import { pendingWakes, TICKED, type Wake, type WakeOn, waking } from "../src/wakes.ts";

/**
 * A job that ended its turn while it or a session below it sleeps on a board.wake is live. Ops guy 10-18: the server told the chat
 * "crawler prod alerts ended, and these open steps name it" at 01:14Z and 01:17Z while its subagents slept on board.wakes for their CI runs
 * (alerts-g-media on runs 39084595194 and 39084587449). The AI harness chat got "[job] multi host fixes ended at 08:47 with no report" six
 * times from 08:47 to 09:27 KST while it slept on a time wake (23:43Z to 23:59Z) and its subagent watchdog-cpu on another (00:13Z to 00:55Z),
 * and the check-in nudged shared prime setup, which slept on runs 39080016755 and 39080016700.
 */
const OPS = "01a115e2-9544-7204-b8db-8ce4d5319048";
const HARNESS = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const NOW = Date.parse("2026-10-18T01:14:50.000Z");
const ALERTS = { id: "sub-9a985a9c", name: "crawler prod alerts", session: "01a14c59-e9e8-7454-9543-5cd6ffccd7d1" };
const MEDIA = { id: "sub-03b5b5a9", name: "alerts-g-media", session: "01a14c78-d7aa-726f-8f29-80507a0d31c4" };
const SNAPSHOT = { id: "sub-6e71eeca", name: "alerts-a-snapshot", session: "01a14c5a-b745-74d0-9d72-8c7392bb0584" };
const MULTI = { id: "sub-4f1c1621", name: "multi host fixes", session: "01a14c39-52f5-727a-93fb-9b11bd397ffb" };
const WATCHDOG = { id: "sub-a99597ad", name: "watchdog-cpu", session: "01a14c4d-3e15-70a2-a85c-c9b37f6ba20d" };
const SHARED = { id: "sub-27a7a305", name: "shared prime setup", session: "01a14bdc-39de-77d4-b32f-8c6566588b8c" };

type Job = { id: string; name: string; session: string };
const child = (job: Job, status: ChildAgent["status"], extra: Partial<ChildAgent> = {}): ChildAgent =>
  ({ id: job.id, label: job.name, sessionName: job.name, sessionId: job.session, status, repliedSinceTask: true, lastActivityAt: NOW - 60_000, ...extra });
const step = (id: string, text: string, job: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "todo", job, children: [], ...extra });

async function wakeDir() {
  const dir = join(await mkdtemp(join(tmpdir(), "job-live-wakes-")), "wakes");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, TICKED), new Date(NOW).toISOString());
  const set = async (session: string, on: WakeOn) => {
    const file = join(dir, `${session}-${on.kind === "run" ? `run-${on.run}` : `time-${Math.round(on.at / 1000)}`}.json`);
    await writeFile(file, JSON.stringify({ session, on, note: "", since: NOW - 15 * 60_000 }));
    return () => rm(file, { force: true });
  };
  return { dir, set };
}

async function server(chat: string, board: ChatBoard | null, dir: string, home?: string) {
  const root = await mkdtemp(join(tmpdir(), "job-live-chat-"));
  const index = new IdIndex(join(root, "chats.json"), "Chat index");
  await index.add(chat);
  const prompts: string[] = [];
  const threads = {
    state: () => ({ messages: [] }), async view() { return null; }, busy: () => false, running: () => false, setWait() {}, isLive: () => false,
    async restart() {}, async prompt(_id: string, input: { message: string }) { prompts.push(input.message); }, async notice() {}, async deleteSubagent() {},
    pin: () => true, unpin() {}, async setSteeringMode() {}, async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {},
    observe() { return () => {}; },
  } as unknown as ChatThreads;
  const source: CheckInSource = {
    board: async () => board, rows: async () => [], memory: checkInRecord(join(root, "check-ins.json")), settings: checkInSettings(join(root, "check-in-settings.json")),
    tickMs: 0, now: () => NOW, noReportGraceMs: 0, waking: session => waking(dir, session), wakes: at => pendingWakes(dir, at), ...(home ? { home } : {}),
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(root, "extension-loads.json")), source);
  const roster = (byChat: ReadonlyMap<string, readonly ChildAgent[]>) =>
    (chats as unknown as { roster(byChat: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> }).roster(byChat);
  const flush = async () => { for (let round = 0; round <= NO_REPORT_BUSY_TRIES + 1; round++) { await new Promise(resolve => setTimeout(resolve, 5)); await chats.settled(); } };
  return { chats, prompts, roster, flush };
}

test("open-steps notice: crawler prod alerts ended its turn while its subagents slept on run wakes, so the chat is told nothing until the wakes are gone (ops guy 10-18 01:14Z)", async () => {
  const board = { plan: [
    step("p623", "Production crawler health snapshot failing", ALERTS.name, { waitFor: "bd3e11b251 lands (run 39082457581)" }),
    step("p625", "Production stream entry waiting over 1 hour", ALERTS.name),
  ], todos: [] } as unknown as ChatBoard;
  const wakes = await wakeDir();
  const { chats, prompts, roster, flush } = await server(OPS, board, wakes.dir);
  const below = [child(MEDIA, "done"), child(SNAPSHOT, "done")];
  const unsetMedia = await wakes.set(MEDIA.session, { kind: "run", run: 39084587449 });
  const unsetSnapshot = await wakes.set(SNAPSHOT.session, { kind: "run", run: 39085516817 });
  await roster(new Map([[OPS, [child(ALERTS, "running")]], [ALERTS.session, below]]));
  await roster(new Map([[OPS, [child(ALERTS, "done")]], [ALERTS.session, below]]));
  await flush();
  assert.deepEqual(prompts.filter(line => line.includes("open step")), [], "two subagents sleep on run wakes: the job is live");
  await unsetMedia();
  await roster(new Map([[OPS, [child(ALERTS, "running")]], [ALERTS.session, below]]));
  await roster(new Map([[OPS, [child(ALERTS, "done", { lastActivityAt: NOW - 30_000 })]], [ALERTS.session, below]]));
  await flush();
  assert.deepEqual(prompts.filter(line => line.includes("open step")), [], "one subagent still sleeps on its run wake");
  await unsetSnapshot();
  await roster(new Map([[OPS, [child(ALERTS, "running")]], [ALERTS.session, below]]));
  await roster(new Map([[OPS, [child(ALERTS, "done", { lastActivityAt: NOW - 10_000 })]], [ALERTS.session, below]]));
  await flush();
  const told = prompts.filter(line => line.includes("open step"));
  assert.equal(told.length, 1, "with every wake gone and no subagent at work, the end is told once");
  assert.ok(told[0]!.startsWith(`${JOB_NOTICE_PREFIX}${ALERTS.name} ended its turn`) && told[0]!.includes("p623") && told[0]!.includes("p625"), told[0]);
  chats.close();
});

test("no-report notice: multi host fixes ended its turn with no reply while it, then its subagent watchdog-cpu, slept on a board.wake, so no 'ended with no report' line goes out (AI harness 10-18 08:47 to 09:27 KST)", async () => {
  const wakes = await wakeDir();
  const { chats, prompts, roster, flush } = await server(HARNESS, null, wakes.dir);
  const watchdog = [child(WATCHDOG, "done")];
  const own = await wakes.set(MULTI.session, { kind: "time", at: Date.parse("2026-10-17T23:59:00.000Z") + 24 * 60 * 60_000 });
  await roster(new Map([[HARNESS, [child(MULTI, "done", { repliedSinceTask: true })]], [MULTI.session, watchdog]]));
  await roster(new Map([[HARNESS, [child(MULTI, "running", { repliedSinceTask: false })]], [MULTI.session, watchdog]]));
  await roster(new Map([[HARNESS, [child(MULTI, "done", { repliedSinceTask: false })]], [MULTI.session, watchdog]]));
  await flush();
  assert.deepEqual(prompts, [], "its own time wake is pending");
  await own();
  const sub = await wakes.set(WATCHDOG.session, { kind: "time", at: Date.parse("2026-10-18T00:55:00.000Z") + 24 * 60 * 60_000 });
  await roster(new Map([[HARNESS, [child(MULTI, "running", { repliedSinceTask: false })]], [MULTI.session, watchdog]]));
  await roster(new Map([[HARNESS, [child(MULTI, "done", { repliedSinceTask: false, lastActivityAt: NOW - 30_000 })]], [MULTI.session, watchdog]]));
  await flush();
  assert.deepEqual(prompts, [], "its subagent's time wake is pending");
  await sub();
  await roster(new Map([[HARNESS, [child(MULTI, "running", { repliedSinceTask: false })]], [MULTI.session, watchdog]]));
  await roster(new Map([[HARNESS, [child(MULTI, "done", { repliedSinceTask: false, lastActivityAt: NOW - 10_000 })]], [MULTI.session, watchdog]]));
  await flush();
  assert.deepEqual(prompts, [`${JOB_NOTICE_PREFIX}${MULTI.name} ended at ${clockTime(NOW - 10_000)} with no report`], "with no wake left the end is told");
  chats.close();
});

const wake = (session: string, on: WakeOn): Wake => ({ session, on, note: "", since: NOW - 60 * 60_000 });

test("check-in: a job whose subagent sleeps on a board.wake reads working with that wake, so the nudge and the restart skip it (AI harness 10-17 22:24Z)", () => {
  const sessions = new Map([[SHARED.id, SHARED.session], [MULTI.id, MULTI.session]]);
  const tree = new Map([[MULTI.session, [WATCHDOG.session]]]);
  const below = (session: string) => tree.get(session) ?? [];
  const wakes = [wake(SHARED.session, { kind: "run", run: 39080016700 }), wake(WATCHDOG.session, { kind: "time", at: Date.parse("2026-10-18T00:55:00.000Z") })];
  const ended = (job: Job): JobFact => ({ key: job.id, name: job.name, state: "ended", activityAt: NOW - 3 * 60 * 60_000, item: { id: "p1", text: "work", status: "doing" } });
  const facts = withWakes([ended(SHARED), ended(MULTI), ended(MEDIA)], wakes, key => sessions.get(key), below);
  assert.deepEqual(facts.map(fact => [fact.name, fact.state, fact.wake]), [
    [SHARED.name, "working", "a board.wake on run 39080016700"],
    [MULTI.name, "working", "a board.wake at 00:55Z"],
    [MEDIA.name, "ended", undefined],
  ]);
  const views = facts.map(fact => ({ item: { id: `p-${fact.key}`, text: fact.name, status: "doing", children: [] }, owner: fact }));
  const { pushes } = jobPushes(facts, views as never, undefined, 30 * 60_000, NOW, () => true, () => NOW - 3 * 60 * 60_000);
  assert.deepEqual(pushes.map(push => push.fact.name), [MEDIA.name], "only the job with no wake in its tree is pushed");
});

test("job row: an agent whose session or subagent sleeps on a board.wake shows the wait, 'waits for run 39080016700'", () => {
  const agent = (job: Job): ChatAgent => ({ key: `child:${job.id}`, sessionId: job.session, childId: job.id, name: job.name, job: job.name, sender: job.name, link: "subagent", state: "idle", steps: [] });
  const tree = new Map([[MULTI.session, [WATCHDOG.session]]]);
  const rows = withWaits([agent(SHARED), agent(MULTI), agent(MEDIA)],
    [wake(SHARED.session, { kind: "run", run: 39080016700 }), wake(WATCHDOG.session, { kind: "time", at: Date.parse("2026-10-18T00:55:00.000Z") })], session => tree.get(session) ?? []);
  assert.deepEqual(rows.map(row => row.wait), ["waits for run 39080016700", "waits for 00:55Z", undefined]);
});

test("pendingWakes: a .ticked stamp past WAKE_LATE_MS keeps run wakes and time wakes still ahead, so a busy service never erases the wake set (AI harness 10-18 01:32Z: p534, p535, p532)", async () => {
  const AT = Date.parse("2026-10-18T01:32:30.000Z");
  const dir = await mkdtemp(join(tmpdir(), "stale-tick-"));
  const files = [
    { session: "01a14b75-84d5-74cc-9f26-cfe5ddbf8741", on: { kind: "run", run: 39081582639 }, note: "land ab71c92731 with --probed on green, then close p534", since: 1792286571228 },
    { session: "01a14b76-9cd4-7779-8361-c9f03fc05609", on: { kind: "run", run: 39086346905 }, note: "p535: land 9feeb12d3b with --probed on green", since: 1792286733989 },
    { session: "01a143a3-12c7-751c-ac79-acb71368065a", root: HARNESS, on: { kind: "time", at: 1792353600000 }, note: "dup-sends recount", since: 1792278972328 },
    { session: "01a14c69-1018-75db-bcfb-05b616e8197b", on: { kind: "time", at: AT - 60_000 }, note: "due a minute ago", since: AT - 10 * 60_000 },
  ];
  for (const wake of files) await writeFile(join(dir, `${wake.session}-${wake.on.kind}.json`), JSON.stringify(wake));
  await writeFile(join(dir, TICKED), new Date(AT - 2 * 60_000 - 15_000).toISOString());
  assert.deepEqual((await pendingWakes(dir, AT)).map(wake => wake.session).sort(), files.slice(0, 3).map(wake => wake.session).sort(),
    "the tick is 2 min 15 s old: both queued-run wakes and the 10-19 time wake stay owed, and only the time wake already due waits for a fresh tick");
  await writeFile(join(dir, TICKED), new Date(AT - 20_000).toISOString());
  assert.equal((await pendingWakes(dir, AT)).length, 4, "with a fresh tick the due time wake is owed too");
  await rm(join(dir, TICKED));
  assert.equal((await pendingWakes(dir, AT)).length, 3, "with no stamp at all the files still name live waits");
});

test("open-steps notice: a new job the hub lists with no session id, whose session folder names the session asleep on a time wake, is live (clean room 10-18 01:46Z, disk space check)", async () => {
  const CHAT = "01a14cac-537d-71f5-8b1c-94a88572a6e2";
  const JOB = { id: "sub-47bdf705", name: "disk space check", session: "01a14cae-aaa4-768e-b9f8-6c6c50f1e10f" };
  const home = await mkdtemp(join(tmpdir(), "job-live-home-"));
  const folder = join(home, ".prime", "agent", "session-artifacts", CHAT, JOB.id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${JOB.session}.jsonl`), "");
  const wakes = await wakeDir();
  await wakes.set(JOB.session, { kind: "time", at: Date.parse("2026-10-18T02:09:56.000Z") + 24 * 60 * 60_000 });
  const board = { plan: [step("p1", "Measure how free disk space changes over 25 minutes", JOB.name, { status: "doing" })], todos: [] } as unknown as ChatBoard;
  const { chats, prompts, roster, flush } = await server(CHAT, board, wakes.dir, home);
  const hub = (status: ChildAgent["status"]): ChildAgent => ({ id: JOB.id, label: JOB.name, sessionName: JOB.name, status, repliedSinceTask: true, lastActivityAt: NOW - 60_000 });
  await roster(new Map([[CHAT, [hub("running")]]]));
  await roster(new Map([[CHAT, [hub("done")]]]));
  await flush();
  assert.deepEqual(prompts.filter(line => line.includes("open step")), []);
  chats.close();
});

test("check-in: subagents the hub's attach lacks after the idle unload and a restart, asleep on run and time wakes, are live owners, not 'not found' (Crawler VP 10-18 03:00Z, p252, p596, crawler ops train)", () => {
  const CRAWLER = OPS;
  const CANARY = { id: "sub-f061e03d", name: "census canary run", session: "01a12faa-591f-751e-b070-756c5697072e" };
  const QUERY = { id: "sub-d52d31b0", name: "query mcp build", session: "01a1421b-29e4-719a-b3e3-aa4768b0aa35" };
  const TRAIN = { id: "sub-96f41d6b", name: "crawler ops train", session: "01a13a74-4d1b-71b8-b9b4-3dc22a80a2e8" };
  const OLD = { id: "sub-05ed6d9b", name: "media worker cpu", session: "01a14c6e-f3a6-77ca-b606-371322b111fa" };
  const wakes = [
    wake(CANARY.session, { kind: "time", at: 1792293660000 }),
    wake(QUERY.session, { kind: "run", run: 39091572149 }), wake(QUERY.session, { kind: "time", at: 1792293000000 }),
    wake(TRAIN.session, { kind: "run", run: 39091941522 }), wake(TRAIN.session, { kind: "time", at: 1792293300000 }),
  ];
  const attached = [child(ALERTS, "done")];
  const roster = [child(CANARY, "done"), child(QUERY, "done"), child(TRAIN, "done"), child(OLD, "done"), child(ALERTS, "done")];
  const children = withLiveRoster(attached, roster, wakes, () => []);
  assert.deepEqual(children.map(each => each.label), [ALERTS.name, CANARY.name, QUERY.name, TRAIN.name], "the finished job with no wake stays out");
  const board = { plan: [{ id: "p23", text: "Speed census up", status: "doing", children: [
    step("p252", "Raise census crawl slots past 768", CANARY.name, { status: "doing", sessionId: CANARY.session }),
    step("p596", "query MCP push", QUERY.name, { status: "doing", sessionId: QUERY.session, waitFor: "run 39076161060 green" }),
    step("p368", "Prod YouTube job queue holds an entry stuck over a day", TRAIN.name),
  ] }], todos: [] } as unknown as ChatBoard;
  const sessions = new Map(children.map(each => [each.id, each.sessionId!]));
  const facts = withWakes(jobFacts(children, board, [], CRAWLER), wakes, key => sessions.get(key));
  const byName = new Map(facts.map(fact => [fact.name, fact]));
  assert.deepEqual([CANARY, QUERY, TRAIN].map(job => [job.name, byName.get(job.name)?.state, byName.get(job.name)?.item?.id]), [
    [CANARY.name, "working", "p252"], [QUERY.name, "working", "p596"], [TRAIN.name, "working", "p368"],
  ]);
  assert.equal(byName.get(QUERY.name)?.wake, "board.wakes on run 39091572149 and at 03:10Z");
});

test("agents API: an agent asleep on a board.wake reads working with its wait, not done (Crawler VP 10-18 03:05Z, query mcp build)", () => {
  const agent: ChatAgent = { key: "child:sub-d52d31b0", sessionId: "01a1421b-29e4-719a-b3e3-aa4768b0aa35", childId: "sub-d52d31b0", name: "query mcp build", job: "query mcp build", sender: "query mcp build", link: "subagent", state: "done", steps: ["p596"] };
  const [row] = withWaits([agent], [wake(agent.sessionId!, { kind: "run", run: 39091572149 })], () => []);
  assert.deepEqual([row!.state, row!.wait], ["working", "waits for run 39091572149"]);
  assert.deepEqual(agentLines([row!], NOW), ["Agents:", "- query mcp build: waits for run 39091572149 (p596)"]);
});
