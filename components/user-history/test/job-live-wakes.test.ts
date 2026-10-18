import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withWaits } from "../src/chat-agents.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { checkInRecord } from "../src/chat-checkin.ts";
import { type ChatThreads, type CheckInSource } from "../src/chat-sources.ts";
import { jobPushes } from "../src/checkin-jobs.ts";
import { withWakes } from "../src/checkin-load.ts";
import { checkInSettings, clockTime } from "../src/checkin-settings.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { Chats, NO_REPORT_BUSY_TRIES } from "../src/chats.ts";
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

async function server(chat: string, board: ChatBoard | null, dir: string) {
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
    tickMs: 0, now: () => NOW, noReportGraceMs: 0, waking: session => waking(dir, session), wakes: at => pendingWakes(dir, at),
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
