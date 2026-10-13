import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord } from "../src/chat-checkin.ts";
import { OWNER_UI } from "../src/checkin-settings.ts";
import type { ThreadView } from "../src/chat-sources.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, ChatBoard, ChildAgent, ModelInfo, SessionRow } from "../src/shared/types.ts";
import { source, fakeThreads, dutySink, row, ownerAsks, reply, TOKEN_FAILURE } from "./chats-helpers.ts";

// Notice times are the owner's local HH:MM; the expected strings are written for Seoul.
process.env.TZ = "Asia/Seoul";

test("chats: a chat whose last turn failed gets a new turn 5, 10, then every 20 min, even with nothing open; a good turn resets; a busy or paused chat waits; no notice queues behind it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const lines: string[] = [];
  const memory = checkInRecord(join(dir, "check-ins.json"));
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [] }] };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => now), line => lines.push(line));
  await chats.adopt();
  threads.transcripts.set("c1", [ownerAsks("[check-in] What changed: p1 finished", now), reply("error", now, "Provider rate limit exceeded (rate_limit_error, 429)")]);
  // The check-ins sent so far sit in its queue with nothing running: `busy`, not `running`. Waiting on `busy` is how 453e stayed dead for 2.6 h.
  threads.queuedIds.add("c1");
  const restarted: number[] = [];
  const run = async (minutes: number) => {
    for (let half = 0; half < minutes * 2; half++) {
      now += 30_000;
      const before = calls.length;
      await chats.tick();
      await chats.settled();
      if (calls.slice(before).some(call => call.startsWith("restart c1"))) restarted.push(Math.round((now - start) / 60_000));
    }
  };
  const start = now;
  await run(60);
  assert.deepEqual(restarted, [5, 15, 35, 55], "5 min after the failure, then 10, then 20, then 20");
  assert.equal(calls.find(call => call.startsWith("restart")), "restart c1 [check-in] Your last turn failed at 22:46 (Provider rate limit exceeded (rate_limit_error, 429)). Re-check the board and continue.");
  assert.deepEqual(calls.filter(call => call.startsWith("steer")), [], "no check-in steer queues into the failed chat");
  assert.match(lines.join("\n"), /chat c1: last turn failed \(Provider rate limit exceeded \(rate_limit_error, 429\)\); started a new turn, try 4/);

  const sink = dutySink();
  const withBoard = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board }, () => now), memory, duty: sink.duty }, line => lines.push(line));
  await withBoard.checkIn("c1");
  assert.equal(sink.runs.length, 1, "the check-in job runs beside the restart schedule: it steers no chat, so it waits for nothing");
  const job = (working: boolean, at: number): ChildAgent => ({ id: "k1", label: "a", sessionName: "ai-risk-blog", status: "done", ...(working ? { activity: { kind: "writing" as const } } : {}),
    repliedSinceTask: false, lastActivityAt: at });
  threads.fire().live("c1", [job(true, 1)]);
  await withBoard.settled();
  calls.length = 0;
  threads.fire().children("c1", [job(false, 1)]);
  await new Promise(resolve => setTimeout(resolve, 5));
  await withBoard.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("steer")), [], "no [job] notice piles up behind the failure");
  assert.match(lines.join("\n"), /no notice for ai-risk-blog: the chat's last turn failed/);
  withBoard.close();

  threads.transcripts.get("c1")!.push(ownerAsks("[check-in] Your last turn failed (429). Re-check the board and continue.", now), reply("stop", now + 1));
  restarted.length = 0;
  await run(10);
  assert.deepEqual(restarted, [], "the new turn ended well");
  const failedAgain = now;
  threads.transcripts.get("c1")!.push(ownerAsks("continue", now), reply("error", now, "Connection error."));
  threads.busyIds.add("c1");
  await run(30);
  assert.deepEqual(restarted, [], "a turn still running is not restarted");
  threads.busyIds.delete("c1");
  await run(1);
  assert.deepEqual(restarted, [Math.round((failedAgain - start) / 60_000) + 31], "the count started over: the first wait (5 min) has long passed");
  await chats.setCheckIn("c1", { pause: "forever" }, OWNER_UI);
  restarted.length = 0;
  await run(60);
  assert.deepEqual(restarted, [], "the owner paused the chat");
  chats.close();
});


const SOL = { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol", input: ["text"], contextWindow: 0, reasoning: true } as ModelInfo;
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", input: ["text"], contextWindow: 0, reasoning: true } as ModelInfo;
const RATE_LIMITED = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit.";
async function recoveryChat(claude: { serves: boolean; freeAt: number | null } | null) {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  threads.catalog = { models: [OPUS, SOL], configuredProviders: ["anthropic", "openai-codex"] };
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const clock = { now: 1_000_000_000, claude };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => clock.now), claude: async () => clock.claude }, line => lines.push(line));
  await chats.adopt();
  const info = (model: ModelInfo, extra: Partial<NonNullable<ThreadView["info"]>> = {}) =>
    threads.extras.set("c1", { info: { model, thinkingLevel: "high", availableThinkingLevels: ["low", "high"], retryAttempt: 0, queuedActions: 0, ...extra } });
  const step = async (seconds = 30) => { clock.now += seconds * 1000; calls.length = 0; await chats.tick(); await chats.settled(); return [...calls]; };
  return { chats, threads, calls, lines, clock, info, step };
}

test("chats: a token failure with no usable Claude account waits and retries on the selected model with unchanged effort", async () => {
  const { chats, threads, clock, info, step } = await recoveryChat({ serves: false, freeAt: clockTimeReset });
  info(OPUS);
  threads.transcripts.set("c1", [ownerAsks("what was the response to t5 question???", clock.now), reply("error", clock.now, TOKEN_FAILURE)]);
  assert.deepEqual(await step(10), []);
  assert.deepEqual(threads.waits.get("c1"), { kind: "account", until: clockTimeReset });
  assert.deepEqual(await step(20), [
    `restart c1 [check-in] Your last turn failed at 22:46 (${TOKEN_FAILURE}). The owner's message is still unanswered: "what was the response to t5 question???". Answer it first.`,
  ]);
  assert.deepEqual(threads.extras.get("c1")?.info?.model, OPUS);
  assert.equal(threads.extras.get("c1")?.info?.thinkingLevel, "high");
  chats.close();
});

const clockTimeReset = 1_000_000_000 + 45 * 60_000;

test("chats: 429 waits on the pinned model if no account serves; usable pool and chosen Codex use normal retry", async () => {
  for (const failure of [RATE_LIMITED, TOKEN_FAILURE]) {
    const down = await recoveryChat({ serves: false, freeAt: null });
    down.info(OPUS);
    down.threads.transcripts.set("c1", [ownerAsks("hi", down.clock.now), reply("error", down.clock.now, failure)]);
    assert.deepEqual(await down.step(10), []);
    assert.deepEqual(down.threads.waits.get("c1"), { kind: "account", until: down.clock.now + 20_000 });
    assert.deepEqual(await down.step(20), [`restart c1 [check-in] Your last turn failed at 22:46 (${failure}). The owner's message is still unanswered: "hi". Answer it first.`]);
    assert.deepEqual(down.threads.extras.get("c1")?.info?.model, OPUS);
    assert.equal(down.threads.extras.get("c1")?.info?.thinkingLevel, "high");
    down.chats.close();
  }

  const served = await recoveryChat({ serves: true, freeAt: null });
  served.info(OPUS);
  served.threads.transcripts.set("c1", [ownerAsks("hi", served.clock.now), reply("error", served.clock.now, RATE_LIMITED)]);
  assert.deepEqual(await served.step(10), []);
  assert.deepEqual(served.threads.waits.get("c1"), { kind: "retry", error: RATE_LIMITED, at: served.clock.now + 20_000 });
  assert.equal((await served.step(20))[0]?.startsWith("restart c1"), true);
  served.chats.close();

  const codex = await recoveryChat({ serves: false, freeAt: null });
  codex.info(SOL);
  codex.threads.transcripts.set("c1", [ownerAsks("hi", codex.clock.now), reply("error", codex.clock.now, TOKEN_FAILURE)]);
  assert.deepEqual(await codex.step(10), []);
  assert.deepEqual(codex.threads.waits.get("c1"), { kind: "retry", error: TOKEN_FAILURE, at: codex.clock.now + 20_000 });
  assert.equal((await codex.step(20))[0]?.startsWith("restart c1"), true);
  codex.chats.close();
});

test("chats: a provider no-account error shows account wait even if the pool cannot be read", async () => {
  const { chats, threads, clock, info, step } = await recoveryChat(null);
  info(OPUS);
  threads.transcripts.set("c1", [ownerAsks("hi", clock.now), reply("error", clock.now, "No Claude account")]);
  assert.deepEqual(await step(10), []);
  assert.deepEqual(threads.waits.get("c1"), { kind: "account", until: clock.now + 20_000 });
  assert.deepEqual(await step(20), [`restart c1 [check-in] Your last turn failed at 22:46 (No Claude account). The owner's message is still unanswered: "hi". Answer it first.`]);
  assert.deepEqual(threads.extras.get("c1")?.info?.model, OPUS);
  assert.equal(threads.extras.get("c1")?.info?.thinkingLevel, "high");
  chats.close();
});

test("chats: scheduler never switches the selected model or effort after a failure or recovery", async () => {
  for (const selected of [OPUS, SOL]) {
    const { chats, threads, clock, info, step } = await recoveryChat({ serves: false, freeAt: null });
    info(selected);
    threads.setModel = async () => { throw new Error("scheduled model change"); };
    threads.setThinking = async () => { throw new Error("scheduled effort change"); };
    threads.transcripts.set("c1", [ownerAsks("hi", clock.now), reply("error", clock.now, RATE_LIMITED)]);
    assert.deepEqual(await step(10), []);
    clock.claude = { serves: true, freeAt: null };
    await step(20);
    threads.transcripts.get("c1")!.push(reply("stop", clock.now));
    assert.deepEqual(await step(), []);
    assert.deepEqual(threads.extras.get("c1")?.info?.model, selected);
    assert.equal(threads.extras.get("c1")?.info?.thinkingLevel, "high");
    chats.close();
  }
});

test("chats: a provider retry that holds queued input is aborted and restarted; one with nothing queued is the session's own", async () => {
  const { chats, threads, clock, info, step } = await recoveryChat({ serves: true, freeAt: null });
  threads.transcripts.set("c1", [ownerAsks("[check-in] What changed: p1", clock.now), reply("error", clock.now, "Connection error.")]);
  threads.busyIds.add("c1");
  info(OPUS, { retryAttempt: 3 });
  for (let minute = 0; minute < 10; minute++) assert.deepEqual(await step(60), [], "no queue: the native retry runs");
  info(OPUS, { retryAttempt: 3, queuedActions: 2 });
  threads.extras.get("c1")!.queue = { steering: ["can you use gpt-sol subagents"], followUp: [] };
  assert.deepEqual(await step(), ["restart c1 [check-in] Your last turn failed at 22:46 (Connection error.). Re-check the board and continue. (abort)"],
    "5 min after the failure, the stranded input runs");
  chats.close();
});

test("chats: a step-owner thread whose last turn failed with input queued gets abort, a continue steer and a resumed queue, on the 5, 10, 20 min schedule", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Ship it", status: "doing", job: "thread:t1", children: [] }] };
  const rows = (): SessionRow[] => [{ id: "t1", name: "TPS thread", cwd: "/r", kind: "live", status: "idle", archived: false, messageCount: 9, failure: "429", lastActivityAt: new Date(now - 60_000).toISOString() } as SessionRow];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, { c1: board }, () => now, rows));
  await chats.adopt();
  threads.transcripts.set("c1", [ownerAsks("go", now), reply("stop", now)]);
  const failed: ThreadView = { messages: [ownerAsks("continue", now - 60_000), reply("error", now - 60_000, "429")], queue: { steering: ["owner: status?"], followUp: [] } };
  threads.views.set("t1", failed);
  const wakes = async () => { calls.length = 0; await chats.checkIn("c1"); await chats.settled(); return calls.filter(call => call.startsWith("restart t1")); };
  assert.deepEqual(await wakes(), ["restart t1 continue (abort)"]);
  now += 60_000;
  assert.deepEqual(await wakes(), [], "not again within 5 min");
  now += 5 * 60_000;
  assert.deepEqual(await wakes(), ["restart t1 continue (abort)"]);
  threads.views.set("t1", { ...failed, queue: { steering: [], followUp: [] } });
  now += 30 * 60_000;
  assert.deepEqual(await wakes(), [], "nothing queued: the check-in line covers it, nothing is stranded");
  // 10-13: the pool held step-owner threads until their slots; a wake before the slot only aborts the wait and meets the same 429.
  const slot = now + 10 * 60_000;
  const held = `429 pi-pool: c@x is limited until ${new Date(slot).toISOString()}; this session waits for its slot at ${new Date(slot).toISOString()}. Try again in 10 minutes.`;
  threads.views.set("t1", { messages: [ownerAsks("continue", now - 60_000), reply("error", now - 60_000, held)], queue: { steering: ["owner: status?"], followUp: [] } });
  assert.deepEqual(await wakes(), [], "the pool holds the turn until its slot");
  now = slot;
  assert.deepEqual(await wakes(), ["restart t1 continue (abort)"], "at the slot the queued input is stranded again");
  chats.close();
});

test("chats: after the owner changes the model or account, a stalled chat restarts now; a plain thread in a provider retry is aborted and resumed", async () => {
  const { chats, threads, clock, info, calls } = await recoveryChat({ serves: true, freeAt: null });
  const lastCalls = () => calls.splice(0);
  info(SOL);
  threads.transcripts.set("c1", [ownerAsks("hi", clock.now), reply("error", clock.now, RATE_LIMITED)]);
  lastCalls();
  await chats.retryNow("c1");
  assert.deepEqual(lastCalls(), [`restart c1 [check-in] Your last turn failed at 22:46 (${RATE_LIMITED}). The owner's message is still unanswered: "hi". Answer it first.`]);
  threads.views.set("t9", { messages: [ownerAsks("hi", 1), reply("error", 2, RATE_LIMITED)], info: { retryAttempt: 2 } });
  threads.busyIds.add("t9");
  await chats.retryNow("t9");
  assert.deepEqual(lastCalls(), ["abort t9", "resume t9"]);
  threads.views.set("t8", { messages: [ownerAsks("hi", 1), reply("stop", 2)] });
  await chats.retryNow("t8");
  assert.deepEqual(lastCalls(), [], "a turn that ended well: nothing to do");
  chats.close();
});

test("chats: a token-command timeout restarts after 30 s, 1 min, 2 min with an unreadable pool (no account wait or model switch); a wake from sleep restarts at once and starts the schedule over", async () => {
  const { chats, threads, clock, info, step, lines } = await recoveryChat(null);
  info(OPUS);
  threads.transcripts.set("c1", [ownerAsks("[check-in] What changed: p1", clock.now), reply("error", clock.now, TOKEN_FAILURE)]);
  const start = clock.now;
  const restarts: number[] = [];
  for (let half = 0; half < 20; half++) if ((await step()).some(call => call.startsWith("restart c1"))) restarts.push((clock.now - start) / 1000);
  assert.deepEqual(restarts, [30, 90, 210, 510], "30 s, then 1 min, 2 min, 5 min after each restart");
  assert.deepEqual(await step(40 * 60), [`restart c1 [check-in] Your last turn failed at 22:46 (${TOKEN_FAILURE}). Re-check the board and continue.`], "the Mac slept 40 min: at once");
  assert.match(lines.join("\n"), /chats: woke after 2400 s; transient failures restart now/);
  assert.match(lines.join("\n"), /started a new turn, try 1 after a sleep/);
  assert.deepEqual(await step(), [], "the schedule starts over: 1 min after the wake restart");
  assert.equal((await step())[0]?.startsWith("restart c1"), true);
  chats.close();
});

test("chats: the subagents and roots of a chat whose last turn failed transiently get a continue on the fast schedule and at once after a sleep; step owners and plain threads do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const failedAt = now;
  const agent = (sessionId: string, link: ChatAgent["link"], state: ChatAgent["state"] = "done", at = failedAt): ChatAgent =>
    ({ key: `thread:${sessionId}`, sessionId, name: sessionId, job: sessionId, sender: sessionId, link, state, lastActivityAt: new Date(at).toISOString(), steps: [] });
  let agents: ChatAgent[] = [agent("j1", "subagent"), agent("r1", "root"), agent("t3", "step"), agent("w1", "subagent", "working")];
  let working = false;
  const rows = (): SessionRow[] => [row("c1", new Date(now).toISOString(), { chat: true, working, agents }), row("u1", new Date(now).toISOString())];
  const awake: boolean[] = [];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => now, rows), awake: value => awake.push(value) }, line => lines.push(line));
  await chats.adopt();
  threads.transcripts.set("c1", [ownerAsks("go", now), reply("stop", now)]);
  const views: string[] = [];
  const view = threads.view.bind(threads);
  threads.view = async (id: string) => { views.push(id); return view(id); };
  const failed = (error: string, at: number): ThreadView => ({ messages: [ownerAsks("[task from parent] build it", at - 1), reply("error", at, error)] });
  threads.views.set("j1", failed(TOKEN_FAILURE, failedAt));
  threads.views.set("r1", failed("Connection error.", failedAt));
  threads.views.set("t3", failed(TOKEN_FAILURE, failedAt));
  threads.views.set("u1", failed(TOKEN_FAILURE, failedAt));
  threads.views.set("w1", failed(TOKEN_FAILURE, failedAt));
  const step = async (seconds = 30) => { now += seconds * 1000; calls.length = 0; await chats.tick(); await chats.settled(); return calls.filter(call => call.startsWith("restart")).sort(); };

  assert.deepEqual(await step(10), [], "10 s: wait");
  assert.deepEqual(await step(20), ["restart j1 continue", "restart r1 continue"], "30 s after the failure, with nothing queued");
  threads.views.set("j1", failed(TOKEN_FAILURE, now + 5_000));
  agents = [agent("j1", "subagent", "done", now + 5_000), ...agents.slice(1)];
  assert.deepEqual(await step(), [], "the woken turn failed again: not before 1 min after the last wake; r1 is not woken twice for one failure");
  assert.deepEqual(await step(), ["restart j1 continue"], "1 min after the last wake");
  assert.deepEqual(await step(5 * 60), [], "once per failure");
  views.length = 0;
  threads.views.set("j1", { messages: [ownerAsks("continue", now), reply("stop", now)] });
  agents = [agent("j1", "subagent", "done", now + 1), ...agents.slice(1)];
  await step();
  assert.deepEqual(views.filter(id => id === "j1"), ["j1"], "a changed job is read once");
  await step();
  assert.deepEqual(views.filter(id => id === "j1"), ["j1"], "a quiet job that ended well is not read again");
  threads.views.set("j1", failed(TOKEN_FAILURE, now));
  agents = [agent("j1", "subagent", "done", now), ...agents.slice(1)];
  assert.deepEqual(await step(40 * 60), ["restart j1 continue"], "a new failure found right after a 40 min sleep: at once");
  assert.match(lines.join("\n"), /job j1: last turn failed \(Failed to resolve API key.*\); woke it after a sleep, try 1/);
  assert.equal(calls.some(call => / (t3|u1|w1|c1) /.test(call)), false, "a step owner, a plain thread, a working job and the chat itself are not touched here");
  assert.deepEqual(awake.slice(-1), [true], "a working job keeps the Mac awake");
  agents = agents.filter(entry => entry.state !== "working");
  await step();
  assert.deepEqual(awake.slice(-1), [false]);
  working = true;
  await step();
  assert.deepEqual(awake.slice(-1), [true], "the chat's own turn counts");
  chats.close();
});
