import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatChildren, type DaemonSession, sessionRows } from "../scripts/duties/board-classes.ts";
import { unresolvedAfterTurn } from "../scripts/duties/unresolved-after-turn.ts";
import { checkInRecord, checkInSettings } from "../src/chat-checkin.ts";
import { CorrectionLedger } from "../src/chat-corrections.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { Chats, type ChatThreads, type CheckInSource, loadRecord } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { PrecheckOutput } from "../src/shared/chat-duties.ts";
import type { ChatAgent, ChatBoard, ChildAgent, SessionRow, ThreadMessage } from "../src/shared/types.ts";

/**
 * The check-in replay: a synthetic set of check-in inputs (four boards, the daemon's sessions, the check-in memory, settings and corrections
 * ledger, all at `capturedAt`) goes through a sequence of ticks and job events, and every steer, nudge, restart and board note the server
 * sends is compared with `expected.json`. That file was written by the check-in code before W38 folded it into the check-in duty (this test
 * run with `REPLAY_RECORD=1` on a copy of the component at e0852e7), so a refactor that changes any line or wake fails here. The inputs hold
 * every step class (live, foryou, waiting, due, stale-chase, orphan), a scope miss and a handoff, steps that look done, a job end with and
 * without a report, a provider-error stop, nudges, an auto note and a fan-out to a check-in job.
 */
process.env.TZ = "Asia/Seoul";
const FIXTURES = join(import.meta.dirname, "fixtures", "checkin-replay");
const A = "00000000-0000-7000-8000-00000000000a";
const B = "00000000-0000-7000-8000-00000000000b";
const C = "00000000-0000-7000-8000-00000000000c";
const D = "00000000-0000-7000-8000-00000000000d";
const MIN = 60_000;

type Observer = Parameters<ChatThreads["observe"]>[0];
type Replay = Awaited<ReturnType<typeof replaySetup>>;
export interface ReplayStep { step: string; due?: string[]; calls: string[]; notes: string[] }

const agentMessage = (from: string, text: string, timestamp: number) =>
  ({ role: "custom", customType: "agent_message", content: `[agent-message from ${from}]\n${text}`, timestamp }) as ThreadMessage;

/**
 * The inputs loaded into a server Chats with fake threads; chat D's transcript holds job landing's report. `extra` adds source fields (the duty
 * sink). Each step's calls are sorted: chats run in their own queues, so their order between chats varies.
 */
export async function replaySetup(extra: (dir: string) => Partial<CheckInSource> = () => ({})) {
  const dir = await mkdtemp(join(tmpdir(), "checkin-replay-"));
  const read = async (name: string) => JSON.parse(await readFile(join(FIXTURES, name), "utf8")) as unknown;
  const { capturedAt, sessions } = await read("sessions.json") as { capturedAt: number; sessions: DaemonSession[] };
  const boards = await read("boards.json") as Record<string, ChatBoard>;
  await writeFile(join(dir, "check-ins.json"), JSON.stringify(await read("check-ins.json")));
  await writeFile(join(dir, "check-in-settings.json"), JSON.stringify(await read("check-in-settings.json")));
  await writeFile(join(dir, "corrections.json"), JSON.stringify(await read("corrections.json")));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of Object.keys(boards).reverse()) await index.add(id);
  let now = capturedAt;
  const calls: string[] = [];
  const notes: string[] = [];
  let observer: Observer | undefined;
  const transcripts = new Map<string, ThreadMessage[]>([[D, [agentMessage("job landing", "the landing page is deployed and the link works", capturedAt - 50 * MIN)]]]);
  const views = new Map<string, { messages: ThreadMessage[] }>();
  let agents: Record<string, ChatAgent[]> = {};
  const rows = (): SessionRow[] => sessionRows(sessions).map(row => { const listed = agents[row.id]; return listed ? { ...row, chat: true, agents: listed } : row; });
  const threads = {
    state: (id: string) => { const messages = transcripts.get(id); return messages ? { messages } : undefined; },
    async view(id: string) { return views.get(id) ?? null; },
    async restart(id: string, message: string, abort?: boolean) { calls.push(`restart ${id} ${message}${abort ? " (abort)" : ""}`); },
    async abort(id: string) { calls.push(`abort ${id}`); },
    async resumeQueue(id: string) { calls.push(`resume ${id}`); },
    async deleteSubagent(id: string, childId: string) { calls.push(`delete ${id} ${childId}`); },
    async models() { return { models: [], configuredProviders: [], current: null, thinkingLevel: null, availableThinkingLevels: [] }; },
    async setModel() {}, async setThinking() {}, async notice(id: string, text: string) { calls.push(`notice ${id} ${text}`); },
    setWait() {}, busy: () => false, running: () => false, async reload() {},
    async create() { return { id: "new" }; }, pin: () => true, unpin() {}, async setSteeringMode() {},
    async heartbeat() { return undefined; }, async clearHeartbeat() {},
    async prompt(id: string, input: { message: string; mode: string }) { calls.push(`${input.mode} ${id} ${input.message}`); },
    observe(next: Observer) { observer = next; return () => { observer = undefined; }; },
  } as unknown as ChatThreads;
  const source: CheckInSource = {
    board: async id => boards[id] ?? null, rows: async () => rows(), memory: checkInRecord(join(dir, "check-ins.json")),
    settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => now, noReportGraceMs: 0,
    writeBoard: async (id, ops) => { notes.push(`${id} ${JSON.stringify(ops)}`); },
    checkInJobs: { dir: join(dir, "check-in-jobs"), board: id => join(dir, "boards", id + ".json") },
    corrections: () => new CorrectionLedger(dir).read(),
    ...extra(dir),
  };
  const logs: string[] = [];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source, line => logs.push(line));
  await chats.adopt();
  const children: Record<string, ChildAgent[]> = Object.fromEntries(Object.keys(boards).map(id => [id, chatChildren(sessions, id)]));
  for (const id of Object.keys(boards)) observer!.live(id, children[id]!);
  await chats.settled();
  const clean = (text: string) => text.split(dir).join("<dir>");
  const steps: ReplayStep[] = [];
  const take = (step: string, due?: string[]) => {
    steps.push({ step, ...(due ? { due } : {}), calls: calls.splice(0).map(clean).sort(), notes: notes.splice(0).map(clean).sort() });
  };
  const tick = async (step: string) => { const due = await chats.tick(); await chats.settled(); take(step, due); };
  /** The no-report notice waits on a timer (its grace is 0 here): let it fire, then wait for the queues. */
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 10)); await chats.settled(); };
  const setChild = (chat: string, name: string, change: (child: ChildAgent) => ChildAgent) => {
    children[chat] = children[chat]!.map(child => child.sessionName === name ? change(child) : child);
    observer!.children(chat, children[chat]!);
  };

  calls.length = 0;
  return { dir, chats, logs, sessions, boards, capturedAt, calls, notes, transcripts, views, steps, take, tick, settle, setChild, observer: () => observer!,
    setNow: (at: number) => { now = at; }, now: () => now, setAgents: (next: Record<string, ChatAgent[]>) => { agents = next; } };
}

/** Runs the replay; `probe` gets the setup first ("setup"), then is called after named steps. */
export async function replay(extra: (dir: string) => Partial<CheckInSource> = () => ({}), probe: (label: string, ctx: Replay) => Promise<void> = async () => {}):
  Promise<{ steps: ReplayStep[]; dir: string }> {
  const ctx = await replaySetup(extra);
  await probe("setup", ctx);
  const { dir, chats, sessions, capturedAt, transcripts, views, steps, take, tick, settle, setChild, setNow, setAgents } = ctx;
  let now = capturedAt + 16 * MIN; setNow(now);
  await tick("t+16m: every chat's first check-in from the recorded memory");
  await probe("t+16m", ctx);

  now += MIN; setNow(now);
  setChild(A, "job push", child => ({ ...child, status: "done", activity: { kind: "writing" }, lastActivityAt: now }));
  setChild(B, "job cleanup", child => ({ ...child, status: "done", activity: { kind: "executing", toolName: "bash" }, lastActivityAt: now }));
  await chats.settled();
  take("t+17m: job push and job cleanup take a follow-up task");
  now += 3 * MIN; setNow(now);
  transcripts.set(A, [agentMessage("job push", "waiting for your go before I publish the release", now - 30_000)]);
  const idle = ({ activity: _activity, ...child }: ChildAgent): ChildAgent => ({ ...child, repliedSinceTask: false, lastActivityAt: now });
  setChild(A, "job push", idle);
  setChild(B, "job cleanup", idle);
  await settle();
  take("t+20m: job push says it waits; job cleanup ends with no report");

  const dashboard = sessions.find(session => session.sessionName === "job dashboard" && session.parentSessionId === C)!;
  now += MIN; setNow(now);
  setAgents({ [C]: [{ key: `child:${dashboard.rlmChildId}`, sessionId: dashboard.sessionId, childId: dashboard.rlmChildId!, name: "job dashboard", job: "job dashboard",
    sender: "job dashboard", link: "subagent", state: "done", lastActivityAt: new Date(now).toISOString(), steps: [] } as ChatAgent] });
  transcripts.set(C, []);
  views.set(dashboard.sessionId, { messages: [
    { role: "user", content: "[task from parent] build the dashboard", timestamp: now - 10 * MIN } as ThreadMessage,
    { role: "assistant", content: [], provider: "p", model: "m", stopReason: "error", timestamp: now,
      errorMessage: "429 rate_limit_error: This request would exceed the rate limit." } as unknown as ThreadMessage] });
  setChild(C, "job dashboard", child => ({ ...child, status: "done", repliedSinceTask: false, lastActivityAt: now }));
  await settle();
  await tick("t+21m: job dashboard stops on a provider error with no report");

  now = capturedAt + 32 * MIN; setNow(now);
  await tick("t+32m: the next check-in");
  now = capturedAt + 26 * 60 * MIN; setNow(now);
  await probe("t+26h before", ctx);
  await tick("t+26h: waits passed, chases escalate, fan-out");
  now += 16 * MIN; setNow(now);
  await tick("t+26h16m: the check-in after that");
  chats.close();
  return { steps, dir };
}

test("check-in replay: the synthetic inputs give the steers, nudges, restarts and notes the pre-W38 check-in gave", async () => {
  const { steps } = await replay();
  const file = join(FIXTURES, "expected.json");
  if (process.env.REPLAY_RECORD === "1") { await writeFile(file, JSON.stringify(steps, null, 1) + "\n"); return; }
  assert.deepEqual(steps, JSON.parse(await readFile(file, "utf8")));
});

/** A duty runner on the replay's data dir, wired the way the backend wires it; `ctx` is bound once the setup returns. */
function dutySink(sent: string[], ctx: () => Replay) {
  let duties: Duties | undefined;
  const make = (dir: string) => duties = new Duties(new DutyStore(dir), { isChat: async () => true, tickMs: 0, now: () => ctx().now(),
    notify: async (id, message) => { sent.push(`steer ${id} ${message}`); }, board: async id => ctx().boards[id] ?? null,
    checkIn: { view: id => ctx().chats.checkInView(id), set: (id, change) => ctx().chats.setCheckIn(id, change), run: id => ctx().chats.runCheckIn(id), measure: id => ctx().chats.measure(id) } });
  return { extra: (dir: string): Partial<CheckInSource> => ({ duty: make(dir) }), duties: () => duties! };
}

test("check-in duty: the same replay through the built-in duty gives the same steers, nudges and notes, and records every run and job event as a duty run", async () => {
  let ctx: Replay | undefined;
  const sink = dutySink([], () => ctx!);
  const { steps, dir } = await replay(sink.extra, async (label, setup) => { if (label === "setup") ctx = setup; });
  assert.deepEqual(steps, JSON.parse(await readFile(join(FIXTURES, "expected.json"), "utf8")), "no steer, wake or note changed in the move");
  const store = new DutyStore(dir);
  const triggers = async (id: string) => (await store.runs(id)).map(run => run.trigger).reverse();
  assert.deepEqual(await triggers(A), ["schedule", "job-waiting", "schedule", "schedule", "schedule"]);
  assert.deepEqual(await triggers(B), ["schedule", "job-ended", "schedule", "schedule", "schedule"]);
  assert.ok((await triggers(C)).includes("job-stopped"), "the provider-error stop is a run of the duty");
  const [first] = (await store.runs(B)).reverse();
  assert.deepEqual([first!.duty, first!.verdict, first!.metrics.orphan_steps?.value, first!.metrics.job_end_unrecorded?.value, first!.flagged?.map(slice => slice.item)],
    ["checkin", "missed", 1, 1, ["p12", "p12"]], "chat B p12: no live owner, and its job ended unrecorded");
  assert.deepEqual(first!.classes, { live: 0, foryou: 0, waiting: 2, due: 0, "stale-chase": 1, orphan: 1 });
  assert.deepEqual([(await store.read(A)).duties, (await store.read(A)).checkIn?.runCount], [[], 5], "the check-in is no standing duty; its run count lives beside the list");
});

test("check-in duty classes on the synthetic boards: orphans, due steps, 24 h chases and scope misses are flagged; named waits, handoffs, For you steps and live jobs stay quiet", async () => {
  const ctx = await replaySetup();
  const items = (output: PrecheckOutput | null) => (output?.flagged ?? []).map(slice => `${slice.kind} ${slice.item}`).sort();
  ctx.setNow(ctx.capturedAt + 16 * MIN);
  await ctx.tick("t+16m");
  assert.deepEqual(items(await ctx.chats.measure(A)), ["job_end_unrecorded p3", "orphan_steps p6", "scope_misses p6"],
    "no false negative: p6 names the build machine, which correction c1 gives to chat B; no false positive: p7 waits on chat B (handed off), p2 and p5 have live owners");
  assert.deepEqual(items(await ctx.chats.measure(B)), ["job_end_unrecorded p12", "orphan_steps p12"], "no false negative: p12 has no live owner (job cleanup idle)");
  assert.deepEqual(items(await ctx.chats.measure(C)), ["due_late p23"],
    "no false negative: p23 is due since 11:30; no false positive: p24 waits until a named time, p22 and p25 have jobs at work");
  assert.deepEqual(items(await ctx.chats.measure(D)), ["job_end_unrecorded p36", "orphan_steps p31", "orphan_steps p36"],
    "no false positive: p35 is covered by an open For you todo, p37 waits until a named time");

  ctx.setNow(ctx.capturedAt + 26 * 60 * MIN);
  const bLater = items(await ctx.chats.measure(B));
  for (const step of ["p13", "p15"]) assert.ok(bLater.includes(`stale_chase_24h ${step}`), `no false negative: chat B ${step} waited 26 h with no change: ${bLater}`);
  assert.ok(bLater.includes("due_late p14"), `no false negative: chat B p14's waitUntil passed: ${bLater}`);
  const cLater = items(await ctx.chats.measure(C));
  assert.ok(!cLater.some(item => item.endsWith(" p24")), `no false positive: a wait named until a later date stays quiet: ${cLater}`);
  ctx.chats.close();
});

test("check-in duty after the chat's turn: a flagged step the chat ignored (chat B p12) comes back by name once and counts once in unresolved_after_turn; a step it handled (chat C p23) does not", async () => {
  const sent: string[] = [];
  let ctx: Replay | undefined;
  const sink = dutySink(sent, () => ctx!);
  ctx = await replaySetup(sink.extra);
  ctx.setNow(ctx.capturedAt + 16 * MIN);
  await ctx.tick("t+16m");
  assert.ok(ctx.steps[0]!.calls.some(call => call.startsWith(`steer ${B} [check-in]`) && call.includes("p12")), "the tick told chat B about p12");
  assert.ok(ctx.steps[0]!.calls.some(call => call.startsWith(`steer ${C} [check-in]`) && call.includes("p23")), "and chat C about p23");
  const p23 = ctx.boards[C]!.plan.flatMap(goal => [goal, ...goal.children]).find(item => item.id === "p23")!;
  p23.waitUntil = new Date(ctx.now() + 24 * 60 * MIN).toISOString();
  ctx.setNow(ctx.now() + 2 * MIN);
  ctx.observer().idle(B);
  ctx.observer().idle(C);
  const store = new DutyStore(ctx.dir);
  const afterTurn = async (id: string) => (await store.runs(id)).filter(run => run.trigger === "after-turn");
  for (let wait = 0; wait < 200 && ((await afterTurn(B)).length === 0 || (await afterTurn(C)).length === 0); wait++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(sent.map(line => line.split("\n")[0]), [`steer ${B} [check-in] duty checkin "Check-in": after your turn the same check still flags this step and the board shows no change on it. ` +
    "Act on each now (a board change, a job for it, or a wait):"], "only the ignored step comes back");
  assert.match(sent[0]!, /\n- p12 \(orphan_steps, job_end_unrecorded\): p12 "Fix: free disk space on the build machine now/);
  const [bRun] = await afterTurn(B);
  const [cRun] = await afterTurn(C);
  assert.deepEqual([bRun!.unresolved?.map(slice => `${slice.kind} ${slice.item}`), bRun!.handled, bRun!.told], [["orphan_steps p12", "job_end_unrecorded p12"], undefined, true]);
  assert.deepEqual([cRun!.unresolved, cRun!.handled, cRun!.told], [undefined, ["p23"], false], "a new waitUntil on p23 is the chat handling it");
  ctx.observer().idle(B);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await afterTurn(B)).length, 1, "one recheck per told run, so the line comes back once");
  const counted = await unresolvedAfterTurn(ctx.dir, Object.keys(ctx.boards), ctx.capturedAt, ctx.now());
  assert.deepEqual(counted.map(slice => [slice.chat, slice.kind, slice.item]), [[B, "unresolved_after_turn", "p12"]]);
  assert.match(counted[0]!.excerpt, /^duty checkin item p12 \(orphan_steps, job_end_unrecorded\) still flagged after the chat's turn with no change/);
  ctx.chats.close();
});
