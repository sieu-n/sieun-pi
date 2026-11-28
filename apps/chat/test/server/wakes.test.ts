/**
 * board.wake for pi threads: apps/chat arms a run, time or check wake from the board skill's request and delivers it to the thread's conversation
 * as an agent message from "board" with today's chat's `[wake]` text, through the legacy ticker (server/wakes.ts). Wakes survive a restart.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/wakes.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { POLL_HINT, readRunState, REAL_GH } from "../../../../legacy/prime/user-history/src/wakes.ts";
import { FIXTURE_IDS } from "../../server/fixture/seed.ts";
import type { SubmitInput } from "../../server/host/types.ts";
import { ChatDb } from "../../server/chat-db.ts";
import { JsonMove } from "../../server/json-move.ts";
import { armWake, startThreadWakes, wakeSession, wakeTarget } from "../../server/wakes.ts";
import { FolderWakes, owedWakesOf, WAKES, WakeRows, type WakeStore } from "../../server/wakes-db.ts";
import { readConfig } from "../../server/config.ts";
import { start } from "./helpers.ts";

const THREAD = "0f3c2a51-7d1e-4b8a-9c55-1d2e3f4a5b6c";
const MIN = 60_000;

/**
 * A temp data dir with its wakes, in the folder or, when APPS_CHAT_DB_KINDS names wakes or `inDb` says so, in its chat.sqlite, a host that
 * records each submit, and a waiter for the next one. The host answers each message at once, or with `busy` set only when `answer` is
 * called, as a thread that works through its queue. `reopen` reads the wakes again as the next server process does.
 */
function rig(t: { after(fn: () => Promise<void> | void): void }, inDb = (readConfig([]).dbKinds ?? []).includes(WAKES.kind)) {
  const dir = mkdtempSync(join(tmpdir(), "apps-chat-wakes-"));
  const chat = inDb ? new ChatDb(join(dir, "chat.sqlite"), { offThread: false }) : undefined;
  const move = chat ? new JsonMove(chat, dir, WAKES) : undefined;
  move?.open();
  const reopen = (): WakeStore => (chat && move ? new WakeRows(chat, move, join(dir, "wakes")) : new FolderWakes(join(dir, "wakes")));
  const wakes = reopen();
  t.after(async () => {
    await move?.flushExports();
    await chat?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const sent: { thread: string; input: SubmitInput }[] = [];
  const answers: (() => void)[] = [];
  const host = {
    busy: false,
    submit: async (thread: string, input: SubmitInput) => { sent.push({ thread, input }); return { submission: sent.length, status: "placed" as const, ticket: { session: "", tree: "", place: { state: "none" as const } } }; },
    wait: async (_thread: string, submission: number) => {
      if (host.busy) await new Promise<void>(done => answers.push(done));
      return { id: submission, conversationId: 1, type: "input", status: "done" };
    },
  };
  const answer = () => { host.busy = false; for (const done of answers.splice(0)) done(); };
  const until = async (count: number, ms = 10_000) => {
    const end = Date.now() + ms;
    while (sent.length < count && Date.now() < end) await new Promise(done => setTimeout(done, 20));
    assert.equal(sent.length, count, `expected ${count} wake sends, got ${sent.length}`);
  };
  return { dir, wakes, sent, host, until, answer, reopen };
}

test("a session key names the thread and its conversation", () => {
  assert.equal(wakeSession(THREAD, 3), `${THREAD}--3`);
  assert.deepEqual(wakeTarget(`${THREAD}--3`), { thread: THREAD, conversation: 3 });
  assert.deepEqual(wakeTarget(THREAD), { thread: THREAD, conversation: 1 });
});

test("a check wake runs sh from home at its pace and wakes the conversation once it exits 0, with its output", async t => {
  const { dir, wakes, sent, host, until } = rig(t);
  const flag = join(dir, "flag");
  const command = `test -f ${flag} && echo landed`;
  await armWake(wakes, THREAD, { conversation: 2, on: { kind: "check", command, every: 100, at: Date.now() + 10 * MIN }, note: "p12" });
  assert.equal(wakes.list().length, 1);
  const stop = startThreadWakes({ wakes, host, log: () => {}, everyMs: 50 });
  t.after(stop);
  await new Promise(done => setTimeout(done, 400));
  assert.equal(sent.length, 0);
  writeFileSync(flag, "");
  await until(1);
  assert.equal(sent[0]!.thread, THREAD);
  assert.equal(sent[0]!.input.conversation, 2);
  assert.deepEqual(sent[0]!.input.entry, { kind: "agent.message", data: { from: "board", via: "wake" } });
  assert.match(sent[0]!.input.text!, new RegExp(`^\\[wake\\] Your board\\.wake check passed at \\S+: \`${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\` exited 0\\. It printed: landed Your note: p12$`));
  await new Promise(done => setTimeout(done, 200));
  assert.equal(sent.length, 1);
  assert.deepEqual(wakes.list(), []);
});

test("arming a check writes its wake without running the command, which board.wake runs in the caller's kernel", async t => {
  const { dir, wakes } = rig(t);
  const ran = join(dir, "ran");
  const armed = await armWake(wakes, THREAD, { on: { kind: "check", command: `touch ${ran}; sleep 5`, every: 5 * MIN, at: Date.now() + MIN }, note: "" });
  assert.deepEqual(wakes.list().map(({ wake }) => wake), [armed.wake]);
  assert.equal(existsSync(ran), false);
  assert.deepEqual(Object.keys(armed).sort(), ["path", "wake"]);
});

test("a check that never passes wakes the conversation at its deadline with its last output", async t => {
  const { wakes, sent, host, until } = rig(t);
  await armWake(wakes, THREAD, { on: { kind: "check", command: "echo 416fae9; exit 1", every: 100, at: Date.now() + 300 }, note: "" });
  const stop = startThreadWakes({ wakes, host, log: () => {}, everyMs: 50 });
  t.after(stop);
  await until(1);
  assert.equal(sent[0]!.input.conversation, undefined);
  assert.match(sent[0]!.input.text!, /^\[wake\] It is \S+, the deadline you set with board\.wake \(\S+\), and your check `echo 416fae9; exit 1` never exited 0\. Its last run printed: 416fae9$/);
});

test("a time wake goes out at its time with Prime's text", async t => {
  const { wakes, sent, host, until } = rig(t);
  const at = Date.now() + 200;
  await armWake(wakes, THREAD, { on: { kind: "time", at }, note: "remeasure" });
  const stop = startThreadWakes({ wakes, host, log: () => {}, everyMs: 50 });
  t.after(stop);
  await until(1);
  assert.match(sent[0]!.input.text!, new RegExp(`^\\[wake\\] It is \\S+, the time you set with board\\.wake \\(${new Date(at).toISOString().replace(/\./g, "\\.")}\\)\\. Your note: remeasure `));
  assert.ok(sent[0]!.input.text!.endsWith(POLL_HINT));
});

/**
 * ci-run-status and gh answers for one run, as the CI cache and GitHub give them; `state` moves the run along. `updatedAt` reads the clock,
 * because a fixed date made rerunMissed answer the attempt 2 wake once that date was RERUN_GAP_MS old.
 */
function ciFixture(run: number) {
  const state = { status: "in_progress", conclusion: "", attempt: 1 };
  const calls: string[] = [];
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args].join(" "));
    const body = { databaseId: run, status: state.status, conclusion: state.conclusion, attempt: state.attempt, url: `https://github.com/sieu-n/auto-sns-agent/actions/runs/${run}`,
      workflowName: "land", headBranch: "main", updatedAt: new Date().toISOString() };
    if (command === "ci-run-status" || command === "gh" || command === REAL_GH) return JSON.stringify(body);
    throw new Error(`unexpected ${command}`);
  };
  return { state, calls, exec };
}

test("a run wake follows the latest attempt, waits for attempt= on a rerun, and names the attempt", async t => {
  const { wakes, sent, host, until } = rig(t);
  const ci = ciFixture(39493311906);
  let now = Date.now();
  await armWake(wakes, THREAD, { on: { kind: "run", run: 39493311906, attempt: 2 }, note: "land r11" }, now);
  let passes = 0;
  const stop = startThreadWakes({ wakes, host, log: () => {}, everyMs: 50, now: () => now, stamp: async () => { passes += 1; return null; }, runState: on => readRunState(on, ci.exec) });
  t.after(stop);
  const waitFor = async (done: () => boolean, what: string) => {
    const end = Date.now() + 10_000;
    while (!done() && Date.now() < end) await new Promise(next => setTimeout(next, 20));
    assert.ok(done(), what);
  };
  /**
   * Moves the clock past RUN_LOOK_MS, waits for the pass that reads the run, then for a later pass to take the wake again, which it does only
   * once the reading pass let go of it. A fixed 150 ms sleep failed in the full parallel suite at load 150, where a pass took longer.
   */
  const step = async () => {
    const reads = ci.calls.length;
    now += 3 * MIN;
    await waitFor(() => ci.calls.length > reads, "a pass reads the run once the clock moved");
    const seen = passes;
    await waitFor(() => passes > seen || sent.length > 0, "the pass that read the run finished");
  };
  await step();
  assert.ok(ci.calls.some(call => call.startsWith("ci-run-status 39493311906")));
  Object.assign(ci.state, { status: "completed", conclusion: "cancelled", attempt: 1 });
  await step();
  assert.equal(sent.length, 0, "a finished attempt 1 does not answer a wake that waits for attempt 2");
  Object.assign(ci.state, { status: "in_progress", conclusion: "", attempt: 2 });
  await step();
  assert.equal(sent.length, 0);
  Object.assign(ci.state, { status: "completed", conclusion: "success", attempt: 2 });
  await step();
  await until(1);
  assert.match(sent[0]!.input.text!, /^\[wake\] Run 39493311906 finished: success \(attempt 2, land on main\)\. It ended at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\. https:\/\/github\.com\/sieu-n\/auto-sns-agent\/actions\/runs\/39493311906 You set this wake with board\.wake\. Your note: land r11$/);
});

test("a run wake in another repo reads gh with that repo", async t => {
  const { wakes, sent, host, until } = rig(t);
  const ci = ciFixture(123);
  Object.assign(ci.state, { status: "completed", conclusion: "failure", attempt: 1 });
  await armWake(wakes, THREAD, { on: { kind: "run", run: 123, repo: "sieu-n/sieun-pi" }, note: "" });
  const stop = startThreadWakes({ wakes, host, log: () => {}, everyMs: 50, runState: on => readRunState(on, ci.exec) });
  t.after(stop);
  await until(1);
  assert.deepEqual(ci.calls, ["gh run view 123 --repo sieu-n/sieun-pi --json status,conclusion,attempt,url,workflowName,headBranch,updatedAt"]);
  assert.match(sent[0]!.input.text!, /^\[wake\] Run 123 in sieu-n\/sieun-pi finished: failure \(attempt 1, land on main\)\. .* A rerun keeps this run id: to wait for its next attempt, set board\.wake\(run=123, attempt=2\)\./);
});

test("wakes set through the route survive a restart of the chat server", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-wakes-restart-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const first = await start({ dataDir });
  const thread = FIXTURE_IDS.vent;
  const at = Date.now() + 1500;
  const time = await first.send("POST", `/api/threads/${thread}/wakes`, { id: `${thread}-1-time`, conversation: 1, on: { kind: "time", at }, note: "after restart", since: Date.now() });
  assert.equal(time.status, 200, JSON.stringify(time.body));
  const old = await first.send("POST", `/api/threads/${thread}/wakes`, { id: `${thread}-1-old`, conversation: 1, at, text: "It is 2026-10-29T03:00:00Z. old kernel" });
  assert.equal(old.body.wake.note, "old kernel");
  const check = await first.send("POST", `/api/threads/${thread}/wakes`, { conversation: 1, on: { kind: "check", command: "exit 1", every: 5 * MIN, at: Date.now() + 60 * MIN }, note: "" });
  assert.equal(check.status, 200);
  assert.equal(check.body.passes, undefined);
  const bad = await first.send("POST", `/api/threads/${thread}/wakes`, { on: { kind: "run", run: -4 } });
  assert.equal(bad.status, 400);
  const none = await first.send("POST", "/api/threads/no-such-thread/wakes", { on: { kind: "time", at } });
  assert.equal(none.status, 400);
  await first.close();
  // For the week after the move each wake also has its JSON export; a file an older release writes after a rollback imports at the next boot.
  assert.equal(readdirSync(join(dataDir, "wakes")).filter(name => name.endsWith(".json")).length, 3);
  writeFileSync(join(dataDir, "wakes", `${thread}-1-time-old.json`), JSON.stringify({ id: `${thread}-1-time-old`, thread, at, text: `It is ${new Date(at).toISOString()}. file of the old chat` }));
  await new Promise(done => setTimeout(done, Math.max(0, at - Date.now()) + 100));
  const second = await start({ dataDir });
  t.after(() => second.close());
  const wakes = async () => (await second.host.entries(thread, { conversation: 1, limit: 1000 })).entries.filter(e => e.kind === "agent.message" && JSON.stringify(e.model).includes("[wake]"));
  const end = Date.now() + 40_000;
  while ((await wakes()).length < 1 && Date.now() < end) await new Promise(done => setTimeout(done, 50));
  const got = await wakes();
  assert.equal(got.length, 1, "one message carries every due wake of the conversation");
  assert.deepEqual(got[0]!.data, { from: "board", via: "wake" });
  const text = (got[0]!.model![0] as { content: { type: string; text: string }[] }).content[0]!.text;
  const lines = text.split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => line.startsWith("[wake] It is ")));
  assert.ok(lines.some(line => line.includes("Your note: after restart")) && lines.some(line => line.includes("Your note: old kernel"))
    && lines.some(line => line.includes("Your note: file of the old chat")));
  // The ticker removes the delivered wakes after the submit answers, so under a full suite's load the message can show first.
  const left = () => second.app.boards.db.wakes.list().length;
  const gone = Date.now() + 10_000;
  while (left() > 1 && Date.now() < gone) await new Promise(done => setTimeout(done, 50));
  assert.equal(left(), 1, "the check wake waits on");
});

for (const store of ["folder", "chat.sqlite"] as const) {
  test(`a wake that went out stays owed until its thread answered the message, across a restart too (${store})`, async t => {
    // Devops guy on 11-28: the check wake whose note named p150 passed at 11:55:57Z, and its message waited in the busy thread's queue until
    // 14:01:37Z. The wake was deleted at the send, so p150 read as a step nobody owned for 126 min, through a release at 13:12:07Z too.
    const { dir, wakes, sent, host, until, answer, reopen } = rig(t, store === "chat.sqlite");
    const note = "p150: linux (demo-unit) passed on dev/sieun-mac";
    const notes = async (from: WakeStore) => (await from.owed(Date.now())).map(wake => wake.note);
    const settled = async (read: () => boolean | Promise<boolean>) => {
      const end = Date.now() + 10_000;
      while (!(await read()) && Date.now() < end) await new Promise(done => setTimeout(done, 20));
      assert.ok(await read());
    };
    host.busy = true;
    await armWake(wakes, THREAD, { id: "p150-wake", on: { kind: "time", at: Date.now() - 1000 }, note });
    const stop = startThreadWakes({ wakes, host, log: () => {}, everyMs: 50 });
    await until(1);
    await new Promise(done => setTimeout(done, 200));
    assert.deepEqual(await notes(wakes), [note], "the step's wake is owed while its message waits in the thread");
    if (store === "chat.sqlite") assert.deepEqual((await owedWakesOf(dir, Date.now(), [WAKES.kind])).map(wake => wake.note), [note], "a duty that reads the rows beside the server reads it owed");
    assert.deepEqual(wakes.list(), [], "the ticker, the board and Remind me read it as gone");
    assert.equal(wakes.get("p150-wake"), undefined);
    stop();

    const next = reopen();
    const stopNext = startThreadWakes({ wakes: next, host, log: () => {}, everyMs: 50 });
    t.after(stopNext);
    await new Promise(done => setTimeout(done, 300));
    assert.equal(sent.length, 1, "the message goes out once");
    assert.deepEqual(await notes(next), [note], "the next server process still owes it");
    answer();
    await settled(async () => (await notes(next)).length === 0);
    assert.deepEqual(next.held(), [], "the wake is gone once the thread answered");
    assert.deepEqual(reopen().held(), []);
  });
}

test("a wake set again under the id of a held one stays when the held one's message is answered", async t => {
  const { wakes, host, until, answer } = rig(t);
  host.busy = true;
  await armWake(wakes, THREAD, { id: "remind", on: { kind: "time", at: Date.now() - 1000 }, note: "first" });
  const stop = startThreadWakes({ wakes, host, log: () => {}, everyMs: 50 });
  t.after(stop);
  await until(1);
  const end = Date.now() + 10_000;
  while (!wakes.held().length && Date.now() < end) await new Promise(done => setTimeout(done, 20));
  await armWake(wakes, THREAD, { id: "remind", on: { kind: "time", at: Date.now() + 60 * MIN }, note: "second" });
  answer();
  await new Promise(done => setTimeout(done, 300));
  assert.deepEqual(wakes.list().map(({ wake }) => wake.note), ["second"]);
});

test("a job thread aliased to an agent gets its wakes itself, not the agent's work thread, and the route lists a conversation's pending wakes", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-wakes-job-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const chat = await start({ dataDir });
  t.after(() => chat.close());
  const job = FIXTURE_IDS.cutover;
  const at = Date.now() + 60 * MIN;
  const armed = await chat.send("POST", `/api/threads/${job}/wakes`, { id: `${job}-2-time`, conversation: 2, on: { kind: "time", at }, note: "job wake", since: Date.now() });
  assert.equal(armed.status, 200, JSON.stringify(armed.body));
  assert.equal(armed.body.wake.session, `${job}--2`);
  const listed = await chat.get(`/api/threads/${job}/wakes?conversation=2`);
  assert.deepEqual(listed.wakes.map((w: { note: string }) => w.note), ["job wake"]);
  assert.deepEqual((await chat.get(`/api/threads/${job}/wakes?conversation=3`)).wakes, []);
  assert.deepEqual((await chat.get(`/api/threads/${FIXTURE_IDS.harness}/wakes?conversation=2`)).wakes, []);
  const due = await chat.send("POST", `/api/threads/${job}/wakes`, { id: `${job}-1-time`, conversation: 1, on: { kind: "time", at: Date.now() - 1000 }, note: "due now", since: Date.now() });
  assert.equal(due.body.wake.session, `${job}--1`);
  const woke = async (thread: string) => (await chat.host.entries(thread, { conversation: 1, limit: 1000 })).entries
    .filter(e => e.kind === "agent.message" && JSON.stringify(e.model).includes("Your note: due now"));
  const end = Date.now() + 40_000;
  while ((await woke(job)).length < 1 && Date.now() < end) await new Promise(done => setTimeout(done, 50));
  assert.equal((await woke(job)).length, 1, "the job's own conversation gets its wake");
  assert.equal((await woke(FIXTURE_IDS.harness)).length, 0, "the agent's work thread gets none");
});
