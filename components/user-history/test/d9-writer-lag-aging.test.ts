// Guards d9's read of Crawler VP's d9 when only the census writer row misses (p895, under p1022). The row counts the worst five-minute slot
// of 24 h, and the precheck dates the miss at the newest counted slot over 5,000. On 10-27 at 00:25Z d9 read fix_not_moving 1 on it, because
// the headline carried no lastEventAt; 07e5b4d4 added it. The key throughput_goals_missed names no window, so d9 still printed no clear time
// and no push read the duty when that slot left the window, until the precheck named the window too (windowMs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { agingSince, agingUntil, fixNotMoving, fixWindowWait, itemsAbove, precheckWindows, sameTargetItems, type RedDuty } from "../scripts/duties/chat-system.ts";
import { agedOut } from "../src/duty-push.ts";
import { judge, type DutyMetric, type DutyRunRecord, type FixLink } from "../src/shared/chat-duties.ts";
import { fixStepStreak, metricStreaks } from "../src/shared/duty-streak.ts";
import type { Wake } from "../src/wakes.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const t = (iso: string): number => Date.parse(`2026-${iso}Z`);
const DAY = 24 * 3_600_000;
const goals: DutyMetric[] = [{ key: "throughput_goals_missed", label: "Throughput goals on the board that prod misses", op: "<=", target: 0, headline: true }];
const p1022: FixLink = { step: "p1022", job: "census pg writer root cause", live: true };

/** One d9 run: one goal missed, p895 at 214,542, and the newest counted slot over 5,000 with the window the precheck names. */
const d9 = (at: string, newestOver: string): DutyRunRecord => ({ duty: "d9", at: t(at), trigger: "verify", ms: 1, fixes: { throughput_goals_missed: p1022 },
  ...judge(goals, { metrics: { throughput_goals_missed: 1 }, items: { p895: { value: 214_542, target: 5_000, op: "<=" } },
    lastEventAt: { throughput_goals_missed: t(newestOver) }, windowMs: { throughput_goals_missed: DAY } }) });
const older = [d9("10-27T01:15:00", "10-27T00:35:00"), d9("10-26T22:47:00", "10-26T22:05:00"), d9("10-26T19:55:00", "10-26T13:00:00")];

function red(runs: readonly DutyRunRecord[]): RedDuty {
  const metric = { ...metricStreaks(runs).find(streak => streak.key === "throughput_goals_missed")!, fix: { step: "p1022", live: true } };
  const since = agingSince(runs);
  const until = agingUntil(runs);
  return { chat: "crawler", duty: "d9", name: "Throughput goal achieved", green: false, misses: metric.misses, stuck: false, metric, fix: "p1022",
    underFix: fixStepStreak(runs, "throughput_goals_missed", "p1022", ["p895"]), ...since === undefined ? {} : { agingSince: since },
    ...until === undefined ? {} : { agingUntil: until } };
}

test("the run copies the window the precheck names onto the metric", () => {
  assert.equal(older[0]!.metrics.throughput_goals_missed!.windowMs, DAY);
  assert.equal(judge(goals, { metrics: { throughput_goals_missed: 1 }, windowMs: { throughput_goals_missed: -1 } }).metrics.throughput_goals_missed!.windowMs, undefined);
});

test("only the writer row misses and its newest slot over 5,000 came before the previous run: d9 reads it aging, with a clear time, not fix_not_moving", () => {
  const runs = [d9("10-27T22:47:00", "10-27T00:35:00"), ...older];
  const duty = red(runs);
  assert.equal(duty.agingSince, t("10-27T00:35:00"));
  assert.equal(duty.agingUntil, t("10-28T00:35:00"));
  assert.deepEqual(fixNotMoving([duty], () => "Crawler VP"), []);
  const counted = new Set(["throughput_goals_missed"]);
  assert.equal(agedOut(runs, counted, t("10-28T00:34:59")), undefined, "the 00:35Z slot still counts");
  assert.equal(agedOut(runs, counted, t("10-28T00:35:00")), t("10-28T00:35:00"), "the duty gets its push once the slot leaves the 24 h");
});

test("a slot over 5,000 after the previous run keeps the miss live, so d9 still asks to replace the fix", () => {
  const runs = [d9("10-27T22:47:00", "10-27T22:30:00"), ...older];
  const duty = red(runs);
  assert.equal(duty.agingSince, undefined);
  const [found] = fixNotMoving([duty], () => "Crawler VP");
  assert.match(found!.line, /^Crawler VP: Throughput goal achieved \(d9\) missed throughput_goals_missed 4 runs in a row, 4 of them under its fix step p1022, p895/);
});

// d9 at 02:25Z on 10-27 asked Crawler VP to replace p1022, while p1022's job (crawler ops train) had committed 86f9c09f2c and slept on run
// 40444358343 to ship it. Its other wake, at 06:00Z on 10-29 about snapshot parts, lies past one window and says nothing about this fix.
test("a fix whose job sleeps on a ship run inside the count's window waits on the window, so d9 asks for no replacement", () => {
  const runs = [d9("10-27T02:20:00", "10-27T01:20:00"), ...older];
  const now = t("10-27T02:25:00");
  const train = "01a15984-a584-7668-aaec-d5a67c824796";
  const ship: Wake = { session: train, on: { kind: "run", run: 40444358343 }, note: "ship 86f9c09f2c", since: t("10-27T02:12:00") };
  const parts: Wake = { session: train, on: { kind: "time", at: t("10-29T06:00:00") }, note: "snapshot parts", since: t("10-26T05:25:00") };
  const step = { sessionId: train };
  const duty = red(runs);
  assert.equal(fixNotMoving([duty], () => "Crawler VP").length, 1, "the old read asks to replace p1022");
  const wait = fixWindowWait(duty.metric, step, [ship, parts], now);
  assert.equal(wait, now + DAY);
  assert.deepEqual(fixNotMoving([{ ...duty, windowWait: wait! }], () => "Crawler VP"), []);
  assert.equal(fixWindowWait(duty.metric, step, [parts], now), undefined, "a wake past one window is no wait on this fix");
  assert.equal(fixWindowWait(duty.metric, { sessionId: "01a17851-b190-72ec-8cdf-83180c1c649c" }, [ship, parts], now), undefined, "another session's wake");
  assert.equal(fixWindowWait(duty.metric, { waitUntil: "2026-10-27T08:00:00Z" }, [], now), t("10-27T08:00:00"));
  assert.equal(fixWindowWait({ key: "throughput_goals_missed" }, step, [ship], now), undefined, "a count with no window has no window to wait on");
});

// The 04:26Z d9 run on 10-27 read the same fix_not_moving 1 with no wake left: run 40444358343 woke p1022's job at 03:39Z. Crawler d9's runs
// from 12:53Z on 10-26 to 00:35Z on 10-27, newest first, as the runs file holds them: none carries windowMs, the 00:35Z one dates its miss, and
// p1022's board target still read 214,542, the 10:55Z slot that came before p1022's first run at 13:28Z.
const STATE = JSON.parse(String.raw`[{"duty": "d9", "at": 1793061310424, "trigger": "verify", "ms": 77412, "verdict": "missed", "metrics": {"throughput_goals_missed": {"value": 1, "target": 0, "op": "<=", "met": false}, "geonode_mbps": {"value": 161, "target": 100, "op": ">=", "met": true}, "ig_queues_growing_6h": {"value": 0, "target": 0, "op": "<=", "met": true}, "crawler_panels_blank": {"value": 0, "target": 0, "op": "<=", "met": true}}, "items": {"p826": {"value": 17978, "target": 10000, "op": ">=", "met": true}, "p696": {"value": 99.99955351334957, "target": 99.5, "op": ">=", "met": true}, "p850": {"value": 314.7909722222222, "target": 299.1509920634921, "op": ">=", "met": true}, "p683": {"value": 0, "target": 1, "op": "<=", "met": true}, "p829": {"value": 99.999, "target": 99.99, "op": ">=", "met": true}, "p895": {"value": 214542, "target": 5000, "op": "<=", "met": false}}, "fixes": {"throughput_goals_missed": {"step": "p1022", "job": "census pg writer root cause", "live": true, "target": {"current": 214542, "target": 5000, "direction": "down", "measuredAt": "2026-10-26T22:47:26.000Z"}}}, "summary": "", "after": {"at": 1793063739693, "verdict": "missed", "metrics": {"throughput_goals_missed": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1793061300000}, "geonode_mbps": {"value": 161, "target": 100, "op": ">=", "met": true}, "ig_queues_growing_6h": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1793063740200}, "crawler_panels_blank": {"value": 0, "target": 0, "op": "<=", "met": true}}, "items": {"p826": {"value": 20240, "target": 10000, "op": ">=", "met": true}, "p696": {"value": 100.00058497329827, "target": 99.5, "op": ">=", "met": true}, "p850": {"value": 321.3777777777778, "target": 301.3169642857143, "op": ">=", "met": true}, "p683": {"value": 0, "target": 1, "op": "<=", "met": true}, "p829": {"value": 99.999, "target": 99.99, "op": ">=", "met": true}, "p895": {"value": 214542, "target": 5000, "op": "<=", "met": false}}, "summary": ""}}, {"duty": "d9", "at": 1793054846080, "trigger": "schedule", "ms": 86019, "verdict": "missed", "metrics": {"throughput_goals_missed": {"value": 1, "target": 0, "op": "<=", "met": false}, "geonode_mbps": {"value": 160.5, "target": 100, "op": ">=", "met": true}, "ig_queues_growing_6h": {"value": 0, "target": 0, "op": "<=", "met": true}, "crawler_panels_blank": {"value": 0, "target": 0, "op": "<=", "met": true}}, "items": {"p826": {"value": 17978, "target": 10000, "op": ">=", "met": true}, "p696": {"value": 99.99622542617635, "target": 99.5, "op": ">=", "met": true}, "p850": {"value": 311.7631944444444, "target": 294.56607142857143, "op": ">=", "met": true}, "p683": {"value": 0, "target": 1, "op": "<=", "met": true}, "p829": {"value": 99.999, "target": 99.99, "op": ">=", "met": true}, "p895": {"value": 214542, "target": 5000, "op": "<=", "met": false}}, "fixes": {"throughput_goals_missed": {"step": "p1022", "job": "census pg writer root cause", "live": true, "target": {"current": 214542, "target": 5000, "direction": "down", "measuredAt": "2026-10-26T19:55:17.000Z"}}}, "summary": "", "after": {"at": 1793055056654, "verdict": "missed", "metrics": {"throughput_goals_missed": {"value": 1, "target": 0, "op": "<=", "met": false}, "geonode_mbps": {"value": 160.6, "target": 100, "op": ">=", "met": true}, "ig_queues_growing_6h": {"value": 0, "target": 0, "op": "<=", "met": true}, "crawler_panels_blank": {"value": 0, "target": 0, "op": "<=", "met": true}}, "items": {"p826": {"value": 17978, "target": 10000, "op": ">=", "met": true}, "p696": {"value": 99.99272820831219, "target": 99.5, "op": ">=", "met": true}, "p850": {"value": 310.99305555555554, "target": 294.6517857142857, "op": ">=", "met": true}, "p683": {"value": 0, "target": 1, "op": "<=", "met": true}, "p829": {"value": 99.999, "target": 99.99, "op": ">=", "met": true}, "p895": {"value": 214542, "target": 5000, "op": "<=", "met": false}}, "summary": ""}}, {"duty": "d9", "at": 1793044517092, "trigger": "verify", "ms": 59610, "verdict": "missed", "metrics": {"throughput_goals_missed": {"value": 1, "target": 0, "op": "<=", "met": false}, "geonode_mbps": {"value": 160.2, "target": 100, "op": ">=", "met": true}, "ig_queues_growing_6h": {"value": 0, "target": 0, "op": "<=", "met": true}, "crawler_panels_blank": {"value": 0, "target": 0, "op": "<=", "met": true}}, "items": {"p826": {"value": 18005, "target": 10000, "op": ">=", "met": true}, "p696": {"value": 99.99725252293256, "target": 99.5, "op": ">=", "met": true}, "p850": {"value": 308.4451388888889, "target": 286.76696428571427, "op": ">=", "met": true}, "p683": {"value": 0, "target": 1, "op": "<=", "met": true}, "p829": {"value": 99.999, "target": 99.99, "op": ">=", "met": true}, "p895": {"value": 214542, "target": 5000, "op": "<=", "met": false}}, "fixes": {"throughput_goals_missed": {"step": "p1022", "job": "census pg writer root cause", "live": true, "target": {"current": 214542, "target": 5000, "direction": "down", "measuredAt": "2026-10-26T13:28:57.000Z"}}}, "summary": "", "after": {"at": 1793044910923, "verdict": "missed", "metrics": {"throughput_goals_missed": {"value": 1, "target": 0, "op": "<=", "met": false}, "geonode_mbps": {"value": 160.2, "target": 100, "op": ">=", "met": true}, "ig_queues_growing_6h": {"value": 0, "target": 0, "op": "<=", "met": true}, "crawler_panels_blank": {"value": 0, "target": 0, "op": "<=", "met": true}}, "items": {"p826": {"value": 17978, "target": 10000, "op": ">=", "met": true}, "p696": {"value": 99.99212830067299, "target": 99.5, "op": ">=", "met": true}, "p850": {"value": 308.43125, "target": 287.1489087301587, "op": ">=", "met": true}, "p683": {"value": 0, "target": 1, "op": "<=", "met": true}, "p829": {"value": 99.999, "target": 99.99, "op": ">=", "met": true}, "p895": {"value": 214542, "target": 5000, "op": "<=", "met": false}}, "summary": ""}}, {"duty": "d9", "at": 1793021337669, "trigger": "verify", "ms": 79685, "verdict": "missed", "metrics": {"throughput_goals_missed": {"value": 1, "target": 0, "op": "<=", "met": false}, "geonode_mbps": {"value": 157.9, "target": 100, "op": ">=", "met": true}, "ig_queues_growing_6h": {"value": 2, "target": 0, "op": "<=", "met": false, "lastEventAt": 1793021337914}, "crawler_panels_blank": {"value": 0, "target": 0, "op": "<=", "met": true}}, "items": {"p826": {"value": 24150, "target": 10000, "op": ">=", "met": true}, "p696": {"value": 99.9927960829242, "target": 99.5, "op": ">=", "met": true}, "p850": {"value": 291.85069444444446, "target": 264.0362103174603, "op": ">=", "met": true}, "p683": {"value": 0, "target": 1, "op": "<=", "met": true}, "p829": {"value": 99.999, "target": 99.99, "op": ">=", "met": true}, "p895": {"value": 214542, "target": 5000, "op": "<=", "met": false}}, "fixes": {"throughput_goals_missed": {"step": "p1022", "job": "census pg writer root cause", "live": true, "target": {"current": 214542, "target": 5000, "direction": "down", "measuredAt": "2026-10-26T12:53:57.000Z"}}, "ig_queues_growing_6h": {"step": "p1007", "job": "instagram media fetch backlog root cause", "live": false}}, "summary": "", "after": {"at": 1793022702684, "verdict": "missed", "metrics": {"throughput_goals_missed": {"value": 1, "target": 0, "op": "<=", "met": false}, "geonode_mbps": {"value": 157.9, "target": 100, "op": ">=", "met": true}, "ig_queues_growing_6h": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1793022703094}, "crawler_panels_blank": {"value": 0, "target": 0, "op": "<=", "met": true}}, "items": {"p826": {"value": 24150, "target": 10000, "op": ">=", "met": true}, "p696": {"value": 99.99680013405428, "target": 99.5, "op": ">=", "met": true}, "p850": {"value": 292.85, "target": 265.8575396825397, "op": ">=", "met": true}, "p683": {"value": 0, "target": 1, "op": "<=", "met": true}, "p829": {"value": 99.999, "target": 99.99, "op": ">=", "met": true}, "p895": {"value": 214542, "target": 5000, "op": "<=", "met": false}}, "summary": ""}}, {"duty": "d9", "at": 1793019237581, "trigger": "verify", "ms": 70257, "verdict": "missed", "metrics": {"throughput_goals_missed": {"value": 1, "target": 0, "op": "<=", "met": false}, "geonode_mbps": {"value": 157.9, "target": 100, "op": ">=", "met": true}, "ig_queues_growing_6h": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1793019238506}, "crawler_panels_blank": {"value": 0, "target": 0, "op": "<=", "met": true}}, "items": {"p826": {"value": 24150, "target": 10000, "op": ">=", "met": true}, "p696": {"value": 99.9970311855404, "target": 99.5, "op": ">=", "met": true}, "p850": {"value": 291.06944444444446, "target": 261.89136904761904, "op": ">=", "met": true}, "p683": {"value": 0, "target": 1, "op": "<=", "met": true}, "p829": {"value": 99.999, "target": 99.99, "op": ">=", "met": true}, "p895": {"value": 214542, "target": 5000, "op": "<=", "met": false}}, "fixes": {"throughput_goals_missed": {"step": "p895", "job": "census writer peak lag", "live": true, "target": {"current": 37968, "target": 5000, "direction": "down", "measuredAt": "2026-10-26T05:36:00.000Z"}}, "ig_queues_growing_6h": {"step": "p1007", "job": "instagram media fetch backlog root cause", "live": true}}, "summary": "", "after": {"at": 1793019811670, "verdict": "missed", "metrics": {"throughput_goals_missed": {"value": 1, "target": 0, "op": "<=", "met": false}, "geonode_mbps": {"value": 157.9, "target": 100, "op": ">=", "met": true}, "ig_queues_growing_6h": {"value": 3, "target": 0, "op": "<=", "met": false, "lastEventAt": 1793019811889}, "crawler_panels_blank": {"value": 0, "target": 0, "op": "<=", "met": true}}, "items": {"p826": {"value": 24150, "target": 10000, "op": ">=", "met": true}, "p696": {"value": 99.99446484480693, "target": 99.5, "op": ">=", "met": true}, "p850": {"value": 291.81180555555557, "target": 262.26349206349204, "op": ">=", "met": true}, "p683": {"value": 0, "target": 1, "op": "<=", "met": true}, "p829": {"value": 99.999, "target": 99.99, "op": ">=", "met": true}, "p895": {"value": 214542, "target": 5000, "op": "<=", "met": false}}, "summary": ""}}]`) as DutyRunRecord[];
const TARGET = "census Postgres writer lag, worst over 24 h at 10k+ profiles a minute";
const BOARD = { v: 2, rev: 1, updatedAt: "2026-10-27T04:26:00Z", todos: [], plan: [
  { id: "p827", text: "p827", status: "doing", children: [{ id: "p895", text: "p895", status: "dropped", children: [], target: { metric: TARGET, target: 5_000, unit: "records", current: 214_542, direction: "down" } }] },
  { id: "p1022", text: "p1022", status: "doing", children: [], sessionId: "01a15984-a584-7668-aaec-d5a67c824796", duty: "d9/throughput_goals_missed",
    target: { metric: TARGET, target: 5_000, unit: "records", current: 214_542, direction: "down" } },
] } as unknown as ChatBoard;

test("at 04:26Z p1022 waits on the window: the precheck's duty file names 24 h, and the runs within 24 h of p1022's first run are not judged", async () => {
  const now = t("10-27T04:26:00");
  const streak = metricStreaks(STATE).find(entry => entry.key === "throughput_goals_missed")!;
  assert.equal(streak.windowMs, undefined, "no run on record carries windowMs");
  assert.ok(streak.lastEventAt !== undefined, "the 00:35Z after-measure dated the miss");
  const windows = await precheckWindows({ command: ["node", "--import", "tsx", "scripts/duties/throughput-goal.ts"], cwd: new URL("..", import.meta.url).pathname, timeoutMs: 1 });
  assert.equal(windows.throughput_goals_missed, DAY);
  const metric = { ...streak, windowMs: windows.throughput_goals_missed!, fix: { step: "p1022", live: true } };
  const base: RedDuty = { chat: "crawler", duty: "d9", name: "Throughput goal achieved", green: false, misses: metric.misses, stuck: false, metric, fix: "p1022" };
  const old = { ...base, underFix: fixStepStreak(STATE, metric.key, "p1022", itemsAbove(BOARD, "p1022")) };
  assert.equal(fixNotMoving([old], () => "Crawler VP").length, 1, "the 04:26Z read");
  assert.deepEqual(sameTargetItems(BOARD, "p1022"), ["p895"]);
  const under = fixStepStreak(STATE, metric.key, "p1022", itemsAbove(BOARD, "p1022"), { own: ["p895"], windowMs: DAY });
  assert.equal(under.misses, 0);
  assert.equal(new Date(STATE[3]!.at).toISOString().slice(0, 16), "2026-10-26T13:28", "p1022's first run");
  assert.equal(under.judgedFrom, STATE[3]!.at + DAY);
  assert.ok(under.judgedFrom! > now);
  assert.deepEqual(fixNotMoving([{ ...base, underFix: under }], () => "Crawler VP"), []);
  assert.equal(fixWindowWait(metric, BOARD.plan[1], [], now), undefined, "no wake is left, so the wait comes from the first run's window");
});

test("past the window, p1022 is judged on p895, the duty's own reading of its target, not on the board target the chat last copied", () => {
  const fresh = (at: string, lag: number): DutyRunRecord => {
    const run = structuredClone(STATE[0]!);
    const items = { ...run.items!, p895: { ...run.items!.p895!, value: lag, met: false } };
    return { ...run, at: t(at), items, after: { ...run.after!, at: t(at) + 60_000, items } };
  };
  const runs = [fresh("10-28T00:47:00", 9_000), fresh("10-27T22:47:00", 11_000), fresh("10-27T14:00:00", 12_266), ...STATE];
  const under = fixStepStreak(runs, "throughput_goals_missed", "p1022", [], { own: ["p895"], windowMs: DAY });
  assert.equal(under.misses, 3);
  assert.deepEqual(under.worked, { item: "p895", from: 12_266, to: 9_000, target: 5_000 });
  assert.equal(under.moved, true);
  assert.equal(fixStepStreak(runs, "throughput_goals_missed", "p1022", [], { windowMs: DAY }).moved, false, "the board copy still read 214,542");
});
