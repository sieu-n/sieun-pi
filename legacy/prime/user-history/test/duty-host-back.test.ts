// From 10-23 to 10-26 the metal-management chat's d1 and d2 read met while their Mac numbers had no value for days: the owner's MacBook Pro
// slept through each morning slot, the runs measured only the box numbers, and nothing measured the Mac once it woke. A run that finds the Mac
// offline on Tailscale now reruns once Tailscale reads it online, and a headline unmeasured for over 24 h reads error, never met.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { dutyState } from "../src/client/duty-card.ts";
import { type Duty, type DutyMetric, type DutyRunRecord, judge, UNMEASURED_HEADLINE_MS } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";

const CHAT = "01a14d31-6ec0-7005-bbe8-c38b7ae73cfb";
const MIN = 60_000;
const HOUR = 60 * MIN;
const METRICS: DutyMetric[] = [
  { key: "tool_rows_off", label: "Tool rows off", op: "<=", target: 0, headline: true },
  { key: "resource_limits_set", label: "Resource limits", op: "<=", target: 0 },
];
const result = (value: number) => ({ value, target: 0, op: "<=" as const, met: value <= 0 });
const run = (at: number, metrics: DutyRunRecord["metrics"], after?: DutyRunRecord["after"]): DutyRunRecord =>
  ({ duty: "d1", at, trigger: "schedule", ms: 1, verdict: "met", metrics, summary: "", ...after ? { after } : {} });
const away = { kind: "host_away", host: "mac", excerpt: "the Mac (100.66.173.18) is offline on the tailnet, asleep or shut, so tool rows are not measured" };

test("a headline unmeasured for over 24 h reads error with the reason first, and one measured within 24 h reads error without that reason", () => {
  const now = Date.parse("2026-10-26T15:00:00Z");
  const output = { metrics: { resource_limits_set: 0 }, flagged: [away] };
  const stale = judge(METRICS, output, { now, runs: [run(now - 24 * HOUR, { resource_limits_set: result(0) }), run(now - 25 * HOUR, { tool_rows_off: result(0), resource_limits_set: result(0) })] });
  assert.equal(stale.verdict, "error");
  assert.match(stale.summary, /^unmeasured: tool_rows_off, the headline, has no value since its last measure at 2026-10-25T14:00Z, 25 h ago, over the 24 h limit; /);
  assert.match(stale.summary, /offline on the tailnet/, "the summary names why it is unmeasured");
  assert.deepEqual(stale.metrics.resource_limits_set, result(0), "the metrics it measured keep their results");
  // An unmeasured metric never counts as met (11-02): within 24 h the run still reads error, only without the stale-headline reason first.
  const fresh = judge(METRICS, output, { now, runs: [run(now - 23 * HOUR, { tool_rows_off: result(0) })] });
  assert.equal(fresh.verdict, "error");
  assert.doesNotMatch(fresh.summary, /^unmeasured:/);
  assert.equal(judge(METRICS, output).verdict, "error", "with no history the verdict is the measure's");
  const afterJob = judge(METRICS, output, { now, runs: [run(now - 30 * HOUR, {}, { at: now - 2 * HOUR, verdict: "met", metrics: { tool_rows_off: result(0) }, summary: "" })] });
  assert.doesNotMatch(afterJob.summary, /^unmeasured:/, "an after-job measure counts as a measure");
  const never = judge(METRICS, output, { now, runs: [run(now - 30 * HOUR, { resource_limits_set: result(0) })] });
  assert.equal(never.verdict, "error");
  assert.match(never.summary, /has no value in any run since 2026-10-25T09:00Z, 30 h ago/);
  assert.doesNotMatch(judge(METRICS, output, { now, runs: [] }).summary, /^unmeasured:/, "a new duty gets its first day");
  assert.equal(judge(METRICS, { metrics: { tool_rows_off: 0, resource_limits_set: 0 } }, { now, runs: [run(now - 40 * HOUR, {})] }).verdict, "met");
  assert.equal(UNMEASURED_HEADLINE_MS, 24 * HOUR);
});

test("a run that waited on the offline Mac reruns once Tailscale reads it online, once, and a stale headline shows red on the card with no job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-host-back-"));
  try {
    const out = join(dir, "out.json");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(out)}, process.env.OUTPUT_FILE);`);
    const store = new DutyStore(dir);
    let now = Date.parse("2026-10-25T21:55:00Z");
    const duty: Duty = {
      id: "d1", name: "Box tools parity", ownerWords: "make us-metal02 match the Mac", goal: "the box matches the Mac", metrics: METRICS,
      schedule: { kind: "every", minutes: 24 * 60 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 },
      onMiss: "Fix each miss.", status: "active", createdAt: now - 72 * HOUR, updatedAt: now - 72 * HOUR, runCount: 0,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const started: string[] = [];
    const asked: string[] = [];
    let macOnline = false;
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      hostOnline: async host => { asked.push(host); return macOnline; },
      jobs: {
        chat: async id => ({ id, name: "metal-management", cwd: dir, board: id }),
        working: async () => false,
        retire: async () => {},
        start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
        ended: async (last, older = []) => [...last, ...older],
        stop: async () => {},
      },
      checkIn: { view: async () => ({ everyMs: 120 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
    });
    const output = async (metrics: Record<string, number>, flagged: object[] = []) => { await writeFile(out, JSON.stringify({ metrics, flagged })); };
    const newest = async () => (await store.runs(CHAT))[0]!;

    await output({ tool_rows_off: 0, resource_limits_set: 0 });
    await duties.runNow(CHAT, "d1");
    await duties.settled();
    now += HOUR;
    await output({ resource_limits_set: 0 }, [away]);
    await duties.runNow(CHAT, "d1");
    await duties.settled();
    const waited = await newest();
    assert.equal(waited.verdict, "error", "an unmeasured headline never reads met, even one measured an hour ago");
    assert.equal(waited.hostAway, "mac");
    const lastRunAt = (await store.list(CHAT))[0]!.lastRunAt;

    now += 10 * MIN;
    await duties.tick();
    await duties.settled();
    assert.equal((await newest()).at, waited.at, "no rerun while Tailscale reads the Mac offline");
    assert.deepEqual(asked, ["mac"]);

    macOnline = true;
    now += 3 * HOUR;
    await output({ tool_rows_off: 0, resource_limits_set: 0 });
    await duties.tick();
    await duties.settled();
    const back = await newest();
    assert.equal(back.trigger, "host-back");
    assert.equal(back.rerunOf, waited.at);
    assert.equal(back.hostAway, undefined);
    assert.deepEqual(back.metrics.tool_rows_off, result(0));
    assert.equal((await store.list(CHAT))[0]!.lastRunAt, lastRunAt, "the rerun leaves the schedule where it was");
    now += 10 * MIN;
    await duties.tick();
    await duties.settled();
    assert.equal((await newest()).at, back.at, "a run that measured the Mac gets no rerun");

    macOnline = false;
    now += 25 * HOUR;
    await output({ resource_limits_set: 0 }, [away]);
    await duties.runNow(CHAT, "d1");
    await duties.settled();
    const stale = await newest();
    assert.equal(stale.verdict, "error");
    assert.match(stale.summary, /^unmeasured: tool_rows_off, the headline/);
    assert.match(stale.error!, /^unmeasured: tool_rows_off/);
    assert.deepEqual(started, [], "a run that reads error only on the offline Mac's headline starts no job");
    const view = { duty, schedule: duty.schedule, paused: false, nextAt: null, running: false, runs: await store.runs(CHAT), priority: "high" as const };
    assert.equal(dutyState(view), "error", "the card shows it red");

    now += HOUR;
    await output({ resource_limits_set: 2 }, [away]);
    await duties.runNow(CHAT, "d1");
    await duties.settled();
    assert.equal((await newest()).verdict, "error");
    assert.equal(started.length, 1, "a stale headline beside a missed metric still starts a job for the miss");
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the reruns waiting on a box that wakes go one at a time, each after the one before has measured", async () => {
  // 11-09 02:55Z: five duty reruns measured the waking MacBook Pro within 4 min, and its 1 min load read 680 on 12 cores.
  const dir = await mkdtemp(join(tmpdir(), "duty-host-back-turns-"));
  try {
    const out = join(dir, "out.json");
    const gate = join(dir, "gate");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { copyFileSync, existsSync } from "node:fs";
      const wait = () => existsSync(${JSON.stringify(gate)}) ? copyFileSync(${JSON.stringify(out)}, process.env.OUTPUT_FILE) : setTimeout(wait, 20);
      wait();`);
    const store = new DutyStore(dir);
    let now = Date.parse("2026-11-09T02:00:00Z");
    const duty = (id: string): Duty => ({
      id, name: `Mac duty ${id}`, ownerWords: "measure the Mac", goal: "the Mac is measured", metrics: METRICS,
      schedule: { kind: "every", minutes: 24 * 60 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 },
      onMiss: "Fix each miss.", status: "active", createdAt: now - 72 * HOUR, updatedAt: now - 72 * HOUR, runCount: 0,
    });
    await store.update(CHAT, duties => { duties.push(duty("d1"), duty("d2")); });
    let macOnline = false;
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath, hostOnline: async () => macOnline,
      jobs: {
        chat: async id => ({ id, name: "metal-management", cwd: dir, board: id }),
        working: async () => false, retire: async () => {}, start: async (_chat, name) => ({ id: "job", name }),
        ended: async (last, older = []) => [...last, ...older], stop: async () => {},
      },
      checkIn: { view: async () => ({ everyMs: 120 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
    });
    const hostBack = async () => (await store.runs(CHAT)).filter(entry => entry.trigger === "host-back").map(entry => entry.duty);
    const measuring = async () => (await duties.view(CHAT)).filter(view => view.running).map(view => view.duty.id);

    await writeFile(gate, "");
    await writeFile(out, JSON.stringify({ metrics: { resource_limits_set: 0 }, flagged: [away] }));
    for (const id of ["d1", "d2"]) await duties.runNow(CHAT, id);
    await duties.settled();

    macOnline = true;
    now += HOUR;
    await rm(gate);
    await writeFile(out, JSON.stringify({ metrics: { tool_rows_off: 0, resource_limits_set: 0 } }));
    await duties.tick();
    const first = await measuring();
    assert.equal(first.length, 1, "one rerun starts when the Mac reads online");
    now += MIN;
    await duties.tick();
    assert.deepEqual(await measuring(), first, "the other waits while the first one measures");

    await writeFile(gate, "");
    await duties.settled();
    assert.deepEqual(await hostBack(), first);
    now += MIN;
    await duties.tick();
    await duties.settled();
    assert.deepEqual((await hostBack()).sort(), ["d1", "d2"], "the next tick after it measured starts the other");
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
