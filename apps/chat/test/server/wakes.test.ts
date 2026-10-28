/**
 * board.wake for pi threads: apps/chat arms a run, time or check wake from the board skill's request and delivers it to the thread's conversation
 * as an agent message from "board" with today's chat's `[wake]` text, through the legacy ticker (server/wakes.ts). Wakes survive a restart.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/wakes.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { POLL_HINT, readRunState, REAL_GH } from "../../../../legacy/prime/user-history/src/wakes.ts";
import { FIXTURE_IDS } from "../../server/fixture/seed.ts";
import type { SubmitInput } from "../../server/host/types.ts";
import { armWake, startThreadWakes, wakeSession, wakeTarget } from "../../server/wakes.ts";
import { start } from "./helpers.ts";

const THREAD = "0f3c2a51-7d1e-4b8a-9c55-1d2e3f4a5b6c";
const MIN = 60_000;

/** A temp wake dir, a host that records each submit, and a waiter for the next one. */
function rig(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "apps-chat-wakes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent: { thread: string; input: SubmitInput }[] = [];
  const host = { submit: async (thread: string, input: SubmitInput) => { sent.push({ thread, input }); return { submission: sent.length, status: "placed" as const, ticket: { session: "", tree: "", place: { state: "none" as const } } }; } };
  const until = async (count: number, ms = 10_000) => {
    const end = Date.now() + ms;
    while (sent.length < count && Date.now() < end) await new Promise(done => setTimeout(done, 20));
    assert.equal(sent.length, count, `expected ${count} wake sends, got ${sent.length}`);
  };
  return { dir, sent, host, until };
}

test("a session key names the thread and its conversation", () => {
  assert.equal(wakeSession(THREAD, 3), `${THREAD}--3`);
  assert.deepEqual(wakeTarget(`${THREAD}--3`), { thread: THREAD, conversation: 3 });
  assert.deepEqual(wakeTarget(THREAD), { thread: THREAD, conversation: 1 });
});

test("a check wake runs sh from home at its pace and wakes the conversation once it exits 0, with its output", async t => {
  const { dir, sent, host, until } = rig(t);
  const flag = join(dir, "flag");
  const command = `test -f ${flag} && echo landed`;
  const armed = await armWake(dir, THREAD, { conversation: 2, on: { kind: "check", command, every: 100, at: Date.now() + 10 * MIN }, note: "p12" });
  assert.equal(armed.passes, undefined);
  assert.ok(existsSync(armed.path));
  const stop = startThreadWakes({ dir, host, log: () => {}, everyMs: 50 });
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
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith(".json")), []);
});

test("arming a check that already exits 0 says so, and the wake is still set", async t => {
  const { dir } = rig(t);
  const armed = await armWake(dir, THREAD, { on: { kind: "check", command: "pwd", every: 5 * MIN, at: Date.now() + MIN }, note: "" });
  assert.deepEqual(armed.passes, { ok: true, output: `${homedir()}\n` }, "the check runs from the home folder");
  assert.ok(existsSync(armed.path));
});

test("a check that never passes wakes the conversation at its deadline with its last output", async t => {
  const { dir, sent, host, until } = rig(t);
  await armWake(dir, THREAD, { on: { kind: "check", command: "echo 416fae9; exit 1", every: 100, at: Date.now() + 300 }, note: "" });
  const stop = startThreadWakes({ dir, host, log: () => {}, everyMs: 50 });
  t.after(stop);
  await until(1);
  assert.equal(sent[0]!.input.conversation, undefined);
  assert.match(sent[0]!.input.text!, /^\[wake\] It is \S+, the deadline you set with board\.wake \(\S+\), and your check `echo 416fae9; exit 1` never exited 0\. Its last run printed: 416fae9$/);
});

test("a time wake goes out at its time with Prime's text", async t => {
  const { dir, sent, host, until } = rig(t);
  const at = Date.now() + 200;
  await armWake(dir, THREAD, { on: { kind: "time", at }, note: "remeasure" });
  const stop = startThreadWakes({ dir, host, log: () => {}, everyMs: 50 });
  t.after(stop);
  await until(1);
  assert.match(sent[0]!.input.text!, new RegExp(`^\\[wake\\] It is \\S+, the time you set with board\\.wake \\(${new Date(at).toISOString().replace(/\./g, "\\.")}\\)\\. Your note: remeasure `));
  assert.ok(sent[0]!.input.text!.endsWith(POLL_HINT));
});

/** ci-run-status and gh answers for one run, as the CI cache and GitHub give them; `state` moves the run along. */
function ciFixture(run: number) {
  const state = { status: "in_progress", conclusion: "", attempt: 1 };
  const calls: string[] = [];
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args].join(" "));
    const body = { databaseId: run, status: state.status, conclusion: state.conclusion, attempt: state.attempt, url: `https://github.com/sieu-n/auto-sns-agent/actions/runs/${run}`,
      workflowName: "land", headBranch: "main", updatedAt: "2026-10-29T03:00:00Z" };
    if (command === "ci-run-status" || command === "gh" || command === REAL_GH) return JSON.stringify(body);
    throw new Error(`unexpected ${command}`);
  };
  return { state, calls, exec };
}

test("a run wake follows the latest attempt, waits for attempt= on a rerun, and names the attempt", async t => {
  const { dir, sent, host, until } = rig(t);
  const ci = ciFixture(39493311906);
  let now = Date.now();
  await armWake(dir, THREAD, { on: { kind: "run", run: 39493311906, attempt: 2 }, note: "land r11" }, undefined, now);
  const stop = startThreadWakes({ dir, host, log: () => {}, everyMs: 50, now: () => now, stamp: async () => null, runState: on => readRunState(on, ci.exec) });
  t.after(stop);
  const step = async () => { now += 3 * MIN; await new Promise(done => setTimeout(done, 150)); };
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
  assert.equal(sent[0]!.input.text, "[wake] Run 39493311906 finished: success (attempt 2, land on main). https://github.com/sieu-n/auto-sns-agent/actions/runs/39493311906 You set this wake with board.wake. Your note: land r11");
});

test("a run wake in another repo reads gh with that repo", async t => {
  const { dir, sent, host, until } = rig(t);
  const ci = ciFixture(123);
  Object.assign(ci.state, { status: "completed", conclusion: "failure", attempt: 1 });
  await armWake(dir, THREAD, { on: { kind: "run", run: 123, repo: "sieu-n/sieun-pi" }, note: "" });
  const stop = startThreadWakes({ dir, host, log: () => {}, everyMs: 50, runState: on => readRunState(on, ci.exec) });
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
  assert.deepEqual(readdirSync(join(dataDir, "wakes")).filter(name => name.endsWith(".json")).length, 1, "the check wake waits on");
});
