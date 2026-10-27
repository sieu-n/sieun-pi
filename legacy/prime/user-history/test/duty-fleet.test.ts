// Guards the duty fleet share that the Chat system duty (d9) reads.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyFleet, readsTheShare, skippedMisses, verdictNow } from "../scripts/duties/duty-fleet.ts";
import { missRuns } from "../scripts/duties/chat-system.ts";
import { CHANGE_APPROACH_MISSES } from "../src/shared/duty-streak.ts";
import { DutyStore } from "../src/chat-duty-store.ts";

const duty = (id: string, key: string, op: ">=" | "<=", target: number) => ({ id, name: `duty ${id}`, ownerWords: "keep it working", goal: "It works.",
  metrics: [{ key, label: key, op, target, headline: true }], schedule: { kind: "every", minutes: 60 }, precheck: { command: ["true"] }, onMiss: "Fix it.", status: "active", runCount: 1 });
const run = (id: string, key: string, value: number, target: number, op: ">=" | "<=", met: boolean, at: number) =>
  ({ duty: id, at, slot: at, trigger: "schedule", ms: 1, verdict: met ? "met" : "missed", metrics: { [key]: { value, target, op, met } }, summary: key });

test("the duty that reads duties_green_pct stays out of the share, so it can reach 100 once every other duty is green", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "duty-fleet-"));
  try {
    const harness = "chat-harness", other = "chat-other";
    await writeFile(join(dataDir, "chats.json"), JSON.stringify({ ids: [harness, other] }));
    await mkdir(join(dataDir, "duties"), { recursive: true });
    const d9 = duty("d9", "duties_green_pct", ">=", 100);
    await writeFile(join(dataDir, "duties", `${harness}.json`), JSON.stringify({ version: 1, duties: [d9] }));
    await writeFile(join(dataDir, "duties", `${other}.json`), JSON.stringify({ version: 1, duties: [duty("d1", "errors", "<=", 0)] }));
    const store = new DutyStore(dataDir);
    await store.appendRun(harness, run("d9", "duties_green_pct", 98.3, 100, ">=", false, 1_000) as never);
    await store.appendRun(other, run("d1", "errors", 0, 0, "<=", true, 1_000) as never);
    const fleet = await dutyFleet({ dataDir, now: 2_000, sessions: () => [] });
    assert.equal(readsTheShare(d9), true);
    // The built-in check-ins have no run here, so they are pending and outside the share.
    assert.deepEqual(fleet.duties.filter(entry => entry.duty !== "checkin").map(entry => `${entry.chat}/${entry.duty}`), ["chat-other/d1"]);
    assert.equal(fleet.metrics.duties_green_pct, 100);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

const HANDSHAKE = "Error: Timed out after 3000ms waiting for the Prime Agent daemon handshake. Socket: /tmp/prime-agent-1001/daemon.sock.";

test("an unreadable session list marks the fleet's session data missing and still counts the green share", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "duty-fleet-"));
  try {
    const chat = "chat-red";
    await writeFile(join(dataDir, "chats.json"), JSON.stringify({ ids: [chat] }));
    await mkdir(join(dataDir, "duties"), { recursive: true });
    await writeFile(join(dataDir, "duties", `${chat}.json`), JSON.stringify({ version: 1, duties: [duty("d1", "errors", "<=", 0), duty("d2", "ok", ">=", 1)] }));
    const store = new DutyStore(dataDir);
    for (let at = 1; at <= CHANGE_APPROACH_MISSES; at++) await store.appendRun(chat, run("d1", "errors", 5, 0, "<=", false, at * 1_000) as never);
    await store.appendRun(chat, run("d2", "ok", 1, 1, ">=", true, 1_000) as never);
    const fleet = await dutyFleet({ dataDir, now: 10_000, sessions: () => { throw new Error(`reading the daemon's session list failed twice: ${HANDSHAKE}`); } });
    assert.match(fleet.sessionsMissing ?? "", /handshake/);
    assert.deepEqual(fleet.flagged.map(slice => slice.kind), ["fleet_data_missing"]);
    assert.equal(fleet.metrics.duties_green_pct, 50);
    assert.equal(fleet.metrics.stuck_duties, 0);
    assert.deepEqual(fleet.duties.filter(entry => entry.duty !== "checkin").map(entry => [entry.duty, entry.green, entry.misses]), [["d1", false, CHANGE_APPROACH_MISSES], ["d2", true, 0]]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

// 10-22 07:40Z: 01a140fb's check-in read red from a 04:16Z goal_gaps miss while its later skipped runs measured a clean board.
test("a check-in run skipped while its last job works still gives the duty's verdict from its measure, when that measure is the newest", () => {
  const missed = run("checkin", "goal_gaps", 1, 0, "<=", false, 1_000) as never;
  const skipped = (met: boolean, at: number) => ({ ...run("checkin", "goal_gaps", met ? 0 : 2, 0, "<=", met, at), verdict: "skipped", summary: "skipped: previous run still working" }) as never;
  assert.equal(verdictNow([skipped(true, 2_000), missed]), "met");
  assert.equal(verdictNow([skipped(false, 2_000), run("checkin", "goal_gaps", 0, 0, "<=", true, 1_000) as never]), "missed");
  assert.equal(verdictNow([{ ...run("checkin", "goal_gaps", 1, 0, "<=", false, 1_000), after: { at: 3_000, verdict: "met", metrics: {}, summary: "" } } as never, skipped(false, 2_000)]), "met",
    "a job's after-measure newer than the skip wins");
  assert.equal(verdictNow([{ duty: "d1", at: 2_000, trigger: "schedule", ms: 1, verdict: "skipped", metrics: {}, summary: "late slot" } as never, missed]), "missed",
    "a skip that measured nothing leaves the older run's verdict");
});

// 10-23 04:07Z: d9 listed sep launch!!'s check-in as red with "0 runs in a row" and no metric, red on stuck_steps 2 from its 03:55Z skipped run.
test("a duty red on skipped runs' measures alone names their missed metric and counts them as skipped runs", async () => {
  const skipped = (value: number, at: number) => ({ ...run("checkin", "stuck_steps", value, 0, "<=", value === 0, at), verdict: "skipped", summary: "skipped: previous run still working" });
  const unmeasured = { duty: "checkin", at: 3_500, trigger: "schedule", ms: 1, verdict: "skipped", metrics: {}, summary: "late slot" };
  const runs = [skipped(2, 4_000), unmeasured, skipped(1, 3_000), skipped(0, 2_500), skipped(3, 2_200), run("checkin", "stuck_steps", 0, 0, "<=", true, 2_000)] as never[];
  assert.deepEqual(skippedMisses(runs).map(entry => (entry as { at: number }).at), [4_000, 3_000], "a skipped run that met ends the count, and one that measured nothing is passed over");
  assert.deepEqual(skippedMisses([skipped(2, 1_500), { ...run("checkin", "stuck_steps", 0, 0, "<=", true, 1_000), after: { at: 2_000, verdict: "met", metrics: {}, summary: "" } }] as never[]), [],
    "a skip older than the newest measured reading counts for nothing");
  const dataDir = await mkdtemp(join(tmpdir(), "duty-fleet-"));
  try {
    const chat = "chat-skips";
    await writeFile(join(dataDir, "chats.json"), JSON.stringify({ ids: [chat] }));
    await mkdir(join(dataDir, "duties"), { recursive: true });
    await writeFile(join(dataDir, "duties", `${chat}.json`), JSON.stringify({ version: 1, duties: [] }));
    const store = new DutyStore(dataDir);
    await store.appendRun(chat, run("checkin", "stuck_steps", 0, 0, "<=", true, 1_000) as never);
    await store.appendRun(chat, skipped(3, 2_000) as never);
    await store.appendRun(chat, skipped(2, 3_000) as never);
    const fleet = await dutyFleet({ dataDir, now: 4_000, sessions: () => [] });
    const checkin = fleet.duties.find(entry => entry.duty === "checkin")!;
    assert.deepEqual([checkin.green, checkin.misses, checkin.skipped, checkin.metric?.key, checkin.metric?.value, checkin.metric?.misses, checkin.metric?.moved],
      [false, 2, true, "stuck_steps", 2, 2, true]);
    assert.equal(fleet.metrics.stuck_duties, 0, "skipped runs alone never make a duty stuck");
    assert.equal(missRuns(checkin), "2 skipped runs in a row");
    assert.equal(missRuns({ misses: 1 }), "1 run");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

// 10-24 02:03Z: d9 read AI harness d11 as "unlabeled_lines 1 against <= 0, 11 runs in a row" while unlabeled_lines had read 0 on the 9 runs
// before; the 11 misses were needed_pct_24h's, met since 01:35Z.
test("a red duty's line counts the runs in a row its named metric missed, not the duty's verdict streak", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "duty-fleet-"));
  try {
    const chat = "chat-d11";
    await writeFile(join(dataDir, "chats.json"), JSON.stringify({ ids: [chat] }));
    await mkdir(join(dataDir, "duties"), { recursive: true });
    const d11 = { ...duty("d11", "needed_pct_24h", ">=", 90), metrics: [{ key: "needed_pct_24h", label: "needed", op: ">=", target: 90, headline: true },
      { key: "unlabeled_lines", label: "unlabeled", op: "<=", target: 0 }] };
    await writeFile(join(dataDir, "duties", `${chat}.json`), JSON.stringify({ version: 1, duties: [d11] }));
    const store = new DutyStore(dataDir);
    const both = (needed: number, unlabeled: number, at: number) => ({ duty: "d11", at, slot: at, trigger: "verify", ms: 1, verdict: needed >= 90 && unlabeled <= 0 ? "met" : "missed",
      metrics: { needed_pct_24h: { value: needed, target: 90, op: ">=", met: needed >= 90 }, unlabeled_lines: { value: unlabeled, target: 0, op: "<=", met: unlabeled <= 0 } }, summary: "d11" });
    for (let at = 1; at <= 10; at++) await store.appendRun(chat, both(87, 0, at * 1_000) as never);
    await store.appendRun(chat, both(90.3, 1, 11_000) as never);
    const fleet = await dutyFleet({ dataDir, now: 12_000, sessions: () => [] });
    const entry = fleet.duties.find(item => item.duty === "d11")!;
    assert.deepEqual([entry.green, entry.metric?.key, entry.misses, missRuns(entry)], [false, "unlabeled_lines", 1, "1 run"]);
    assert.equal(fleet.metrics.stuck_duties, 0, "one miss of its metric is no stuck duty");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

// 10-25 21:32Z: d9 read Crawler VP's d5 as fix_not_moving under p952, while at 21:35Z the chat had moved d5/crawler_risks_firing to p998 and its
// create_session job; d5 runs daily, so its 21:24Z run kept recording p952 as the fix for a day.
test("a recorded fix whose step no longer carries the duty link gives way to the linked step whose job works", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "duty-fleet-"));
  try {
    const chat = "chat-crawler", root = "01a1702b-7ba4-7588-b36b-86711091ca98", now = Date.parse("2026-10-25T22:00:00Z");
    await writeFile(join(dataDir, "chats.json"), JSON.stringify({ ids: [chat] }));
    await mkdir(join(dataDir, "duties"), { recursive: true });
    await mkdir(join(dataDir, "boards"), { recursive: true });
    await writeFile(join(dataDir, "duties", `${chat}.json`), JSON.stringify({ version: 1, duties: [duty("d5", "crawler_risks_firing", "<=", 0)] }));
    const step = (id: string, extra: object) => ({ id, text: `step ${id}`, status: "doing", children: [], ...extra });
    const plan = [step("p952", { job: "nvme0 and root disk writes root cause" }), step("p998", { job: root, sessionId: root, duty: "d5/crawler_risks_firing" })];
    await writeFile(join(dataDir, "boards", `${chat}.json`), JSON.stringify({ v: 2, rev: 1, plan, todos: [], updatedAt: new Date(now).toISOString() }));
    const store = new DutyStore(dataDir);
    for (let at = 1; at <= CHANGE_APPROACH_MISSES; at++) await store.appendRun(chat, { ...run("d5", "crawler_risks_firing", 1, 0, "<=", false, at * 1_000),
      fixes: { crawler_risks_firing: { step: "p952", job: "nvme0 and root disk writes root cause", live: true } } } as never);
    const sessions = [{ sessionId: root, activity: "working", lastActivityAt: new Date(now).toISOString() }];
    const fleet = await dutyFleet({ dataDir, now, sessions: () => sessions });
    const d5 = fleet.duties.find(entry => entry.duty === "d5")!;
    assert.deepEqual([d5.fix, d5.metric?.fix?.step, d5.stuck], ["p998", "p998", false]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a red duty one run old names the linked step whose job works, and a short streak with no fix is not stuck", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "duty-fleet-"));
  try {
    const chat = "chat-portal", root = "01a1730c-0000-7000-8000-000000000071", now = Date.parse("2026-10-26T02:13:00Z");
    await writeFile(join(dataDir, "chats.json"), JSON.stringify({ ids: [chat] }));
    await mkdir(join(dataDir, "duties"), { recursive: true });
    await mkdir(join(dataDir, "boards"), { recursive: true });
    await writeFile(join(dataDir, "duties", `${chat}.json`), JSON.stringify({ version: 1, duties: [duty("d1", "probe_uptime_24h_pct", ">=", 100), duty("d2", "prod_working_pct", ">=", 100)] }));
    const plan = [{ id: "p71", text: "step p71", status: "doing", children: [], job: root, sessionId: root, duty: "d1/probe_uptime_24h_pct" }];
    await writeFile(join(dataDir, "boards", `${chat}.json`), JSON.stringify({ v: 2, rev: 1, plan, todos: [], updatedAt: new Date(now).toISOString() }));
    const store = new DutyStore(dataDir);
    await store.appendRun(chat, run("d1", "probe_uptime_24h_pct", 99.9, 100, ">=", false, 1_000) as never);
    await store.appendRun(chat, run("d2", "prod_working_pct", 99.4, 100, ">=", false, 2_000) as never);
    const sessions = [{ sessionId: root, activity: "working", lastActivityAt: new Date(now).toISOString() }];
    const fleet = await dutyFleet({ dataDir, now, sessions: () => sessions });
    const d1 = fleet.duties.find(entry => entry.duty === "d1")!, d2 = fleet.duties.find(entry => entry.duty === "d2")!;
    assert.deepEqual([d1.fix, d1.stuck, d2.fix, d2.stuck, fleet.metrics.stuck_duties], ["p71", false, undefined, false, 0]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
