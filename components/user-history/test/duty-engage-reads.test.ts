import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DutyStore } from "../src/chat-duty-store.ts";
import { type DutyMetric, judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import {
  type Account, type DayPages, type Death, type EngageData, canaryRoster, causeOf, deepWalksOf, measure, parseArms, provenRate, report, stagingDueOf, stagingPausesOf,
} from "../scripts/duties/engage-reads.ts";
import { UNMEASURED, frameRows, frameSeries, grafanaAuth, missValue } from "../scripts/duties/estate-reads.ts";

const NOW = Date.parse("2026-10-14T03:00:00Z");
const MIN = 60_000;
const FILE = join(import.meta.dirname, "..", "scripts", "duties", "engage-reads.duty.json");
const dutyMetrics = async (): Promise<DutyMetric[]> => parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW).metrics;
const account = (id: number, status = "active"): Account => ({ id, status });
const death = (accountId: number, fields: Partial<Death> = {}): Death =>
  ({ accountId, at: NOW - 30 * MIN, status: "challenged", code: "challenge_required", readBefore: true, pages24h: 500, ...fields });
/** `count` accounts reading `pages` on each day. */
const reads = (days: string[], count: number, pages: number, firstId = 1): DayPages[] =>
  days.flatMap(day => Array.from({ length: count }, (_, index) => ({ day, accountId: firstId + index, pages })));

function data(fields: Partial<EngageData> = {}): EngageData {
  return { now: NOW, errors: [], stagingLastReadAt: NOW - 5 * MIN, stagingDue: { due: 0, waitMin: 0 }, accounts: Array.from({ length: 100 }, (_, index) => account(index + 1)), deaths: [],
    days: reads(["2026-10-12", "2026-10-13"], 100, 1000), healthy: 100, deepWalks: { reached: 995, errors: { invalid_request: 5 } },
    config: { "engage.rate_test_arms": "2000:1,2,3,4,5,6,7,8,9,10", "engage.rate_test_started_at": "2026-10-12T03:00:00+00:00" }, ...fields };
}

test("engage reads: the duty file parses, its name passes c38, and the precheck writes every metric key", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "09:00" });
  assert.equal(duty.precheck.cwd, "../..");
  const output = report(data(), duty.metrics);
  assert.deepEqual(Object.keys(output.metrics).sort(), duty.metrics.map(metric => metric.key).sort());
});

test("engage reads: 100 healthy accounts at a proven 1,000 pages a day meet every target", async () => {
  const metrics = await dutyMetrics();
  const output = report(data(), metrics);
  assert.equal(output.metrics.prod_capacity_pages_day, 100_000);
  assert.equal(output.metrics.deep_walk_ok_pct, 99.5);
  assert.equal(output.metrics.canary_accounts_short, 0);
  assert.equal(judge(metrics, output).verdict, "met");
});

test("engage reads: capacity is healthy accounts times the proven rate, and its line says how many more accounts reach 100k", async () => {
  const output = report(data({ healthy: 95, days: reads(["2026-10-12", "2026-10-13"], 95, 962) }), await dutyMetrics());
  assert.equal(output.metrics.prod_capacity_pages_day, 91_390);
  const line = output.flagged!.find(item => item.kind === "capacity")!.excerpt;
  assert.match(line, /95 healthy prod accounts .* x 962 pages a day per account, proven on 2026-10-12 and 2026-10-13/);
  assert.match(line, /9 more healthy accounts at that rate reach 100,000/);
  assert.match(line, /100 prod accounts on hand \(not dead\) x 962 = 96,200, short of 100,000/);
});

test("engage reads: a rate is proven by a canary's worth of accounts on 2 consecutive full UTC days with no Instagram verdict at or under it", () => {
  const days = [...reads(["2026-10-10", "2026-10-11"], 90, 500, 11), ...reads(["2026-10-10", "2026-10-11"], 10, 2000)];
  assert.deepEqual(provenRate(days, [], 10), { rate: 2000, days: ["2026-10-10", "2026-10-11"] });
  assert.deepEqual(provenRate(days, [], 11), { rate: 500, days: ["2026-10-10", "2026-10-11"] }, "the 11th busiest account read 500");
  assert.equal(provenRate(reads(["2026-10-10", "2026-10-12"], 10, 900), [], 10), null, "two days apart prove nothing");
  assert.equal(provenRate(reads(["2026-10-10"], 10, 900), [], 10), null, "one day proves nothing");
  const at = Date.parse("2026-10-11T12:00:00Z");
  assert.deepEqual(provenRate(days, [death(1, { at, pages24h: 1900 })], 10), { rate: 500, days: ["2026-10-10", "2026-10-11"] },
    "a canary verdict at 1,900 pages unproves 2,000 but not 500");
  assert.equal(provenRate(days, [death(1, { at, pages24h: 2100 })], 10)?.rate, 2000, "a verdict above the rate leaves it proven");
  assert.equal(provenRate(days, [death(20, { at, pages24h: 300 })], 10), null, "a verdict at 300 pages unproves both rates that day");
  assert.deepEqual(provenRate(days, [death(20, { at, pages24h: 300, code: "transport" })], 10)?.rate, 2000, "our own freeze is no verdict");
  assert.equal(provenRate(days, [death(20, { at: Date.parse("2026-10-13T08:00:00Z"), pages24h: 400 })], 10), null, "a later verdict at 400 pages withdraws both");
  assert.equal(provenRate(days, [death(20, { at, pages24h: 0 })], 10)?.rate, 2000, "a verdict after 0 pages in 24 h says nothing about a rate");
});

test("engage reads: kills split by cause and by canary, a move between dead statuses is one kill, and the 24 h line holds", async () => {
  const deaths = [
    death(1, { at: NOW - 30 * MIN }), death(1, { at: NOW - 20 * MIN, status: "disabled", code: "account_suspended" }),
    death(2, { at: NOW - 3 * 60 * MIN, code: "account_suspended" }),
    death(3, { at: NOW - 59 * MIN, code: "transport", status: "frozen" }),
    death(20, { at: NOW - 10 * MIN, code: null, status: "frozen" }),
    death(21, { at: NOW - 10 * MIN, code: "challenged", readBefore: false }),
    death(22, { at: NOW - 25 * 60 * MIN, code: "challenged" }),
    death(23, { at: NOW - 2 * 60 * MIN, code: "challenge_required" }),
    death(24, { at: NOW - 4 * 60 * MIN, code: "sentry_block" }),
  ];
  const output = report(data({ deaths, config: { "engage.rate_test_arms": "50:1,2,3;800:4,5,6,7,8,9,10", "engage.rate_test_started_at": "2026-10-12T03:00:00Z", "pause.engage_tagged": "true" } }), await dutyMetrics());
  assert.equal(output.metrics.canary_ig_deaths_1h, 1, "account 1 once; 2 is older than an hour, 3 is ours");
  assert.equal(output.metrics.fleet_ig_killed_pct, 2, "23 and 24 of 100: 20 has no code, 21 never read, 22 is older than 24 h");
  const kinds = output.flagged!.map(item => item.kind);
  assert.ok(kinds.includes("pause"));
  assert.equal(kinds.filter(kind => kind === "death").length, 8);
});

test("engage reads: deep walks count error stops against walks that reached their end", async () => {
  assert.deepEqual(deepWalksOf("reached\t\t847\nerror\tinvalid_request\t13\nerror\tcursor_stalled\t1\n"), { reached: 847, errors: { invalid_request: 13, cursor_stalled: 1 } });
  assert.throws(() => deepWalksOf("what\t\t1\n"), /unexpected/);
  const output = report(data({ deepWalks: { reached: 847, errors: { invalid_request: 13, cursor_stalled: 1, repeated_content: 3 } } }), await dutyMetrics());
  assert.equal(output.metrics.deep_walk_ok_pct, 98);
  assert.match(output.flagged!.find(item => item.kind === "deep_walks")!.excerpt, /847 reached their end, 17 stopped on an error/);
});

test("engage reads: a due staging read waiting past the target names each staging pause row on and its last writer, and marks a deploy's leftover", async () => {
  const metrics = await dutyMetrics();
  const stagingPauses = stagingPausesOf([
    { key: "pause.crawl", id: 13588, at: Date.parse("2026-09-23T09:34:00Z"), actor: "metal-deploy", reason: "metal deploy 737c640e7d8e: admissions closed" },
    { key: "pause.enrich", id: 14212, at: Date.parse("2026-10-13T22:39:00Z"), actor: "api-key", reason: "owner: \"can we not enrich for now?\"" },
    { key: "pause.odd", id: null, at: null, actor: null, reason: null },
  ]);
  const stalled = report(data({ stagingLastReadAt: NOW - 157 * MIN, stagingDue: { due: 4, waitMin: 95.5 }, stagingPauses }), metrics);
  assert.equal(stalled.metrics.staging_due_wait_min, 95.5);
  assert.equal(judge(metrics, stalled).verdict, "missed");
  const line = stalled.flagged!.find(item => item.kind === "staging_stall")!.excerpt;
  assert.match(line, /^the oldest of 4 due staging collab reads has waited 95\.5 min \(target 60\), last staging page read 10-14 00:23Z\./);
  assert.match(line, /pause\.crawl \(audit 13588, 09-23 09:34Z, LEFT BY A DEPLOY, metal-deploy: metal deploy 737c640e7d8e: admissions closed\)/);
  assert.match(line, /pause\.enrich \(audit 14212, 10-13 22:39Z, api-key: owner/);
  assert.match(line, /pause\.odd \(no config_audit row\)/);
  const quiet = report(data({ stagingDue: { due: 1, waitMin: 61 }, stagingPauses: [] }), metrics);
  assert.match(quiet.flagged!.find(item => item.kind === "staging_stall")!.excerpt, /No staging pause row is 'true'\. Then read the staging refusal reasons/);
  const bursty = report(data({ stagingLastReadAt: NOW - 400 * MIN, stagingDue: { due: 0, waitMin: 0 }, stagingPauses }), metrics);
  assert.equal(bursty.flagged!.some(item => item.kind === "staging_stall"), false, "hours since the last read with nothing due is staging working as the owner set it (t17)");
  assert.equal(judge(metrics, bursty).verdict, "met");
  assert.deepEqual(stagingDueOf("3\t42.5\n"), { due: 3, waitMin: 42.5 });
  assert.deepEqual(stagingDueOf("0\t0\n"), { due: 0, waitMin: 0 });
  assert.throws(() => stagingDueOf("what\n"), /unexpected/);
});

test("engage reads: a failed source reports source_errors and a value that misses, never a fake good one", async () => {
  const metrics = await dutyMetrics();
  const { accounts: _accounts, ...rest } = data();
  const output = report({ ...rest, errors: [{ source: "prod accounts", message: "permission denied for table ig_engage_accounts" }] }, metrics);
  assert.equal(output.metrics.source_errors, 1);
  assert.equal(output.metrics.prod_capacity_pages_day, -UNMEASURED);
  assert.equal(output.metrics.fleet_ig_killed_pct, UNMEASURED);
  assert.equal(output.metrics.deep_walk_ok_pct, 99.5);
  assert.ok(output.flagged!.some(item => item.kind === "unmeasured"));
  assert.equal(judge(metrics, output).verdict, "missed");
});

test("engage reads: no Grafana login still gives a value for every metric, and the deep walks still read", async () => {
  const metrics = await dutyMetrics();
  const output = report(await measure(null, "GRAFANA_ADMIN_PASSWORD is missing", NOW, async () => "reached\t\t10\n", async () => "2\t15\n"), metrics);
  assert.deepEqual(Object.keys(output.metrics).sort(), metrics.map(metric => metric.key).sort());
  assert.equal(output.metrics.source_errors, 7);
  assert.equal(output.metrics.deep_walk_ok_pct, 100);
  assert.equal(output.metrics.staging_due_wait_min, 15, "the staging due read comes over ssh, not Grafana");
  assert.notEqual(judge(metrics, output).verdict, "error");
});

test("engage reads: the roster parser and the cause rule match rate_test.py and engage_deaths.py", () => {
  assert.deepEqual(parseArms("50:101,102; 800:103"), [{ dailyPages: 50, ids: [101, 102] }, { dailyPages: 800, ids: [103] }]);
  assert.throws(() => parseArms("50:1;80:1"), /twice/);
  assert.throws(() => parseArms("0:1"), /above 0/);
  assert.throws(() => parseArms("50"), /form/);
  assert.equal(canaryRoster({}, NOW).ids.size, 0);
  assert.equal(canaryRoster({ "engage.rate_test_arms": "50:1", "engage.rate_test_started_at": "2026-10-14T15:00:00Z" }, NOW).ids.size, 0, "a start in the future runs nothing yet");
  assert.equal(canaryRoster({ "engage.rate_test_arms": "50:1", "engage.rate_test_started_at": "2026-10-12T03:00:00" }, NOW).ids.size, 0, "a start with no offset is refused");
  assert.match(canaryRoster({ "engage.rate_test_arms": "x:1", "engage.rate_test_started_at": "2026-10-12T03:00:00Z" }, NOW).note, /refused/);
  assert.equal(causeOf({ code: "challenge_required", readBefore: true }), "instagram");
  assert.equal(causeOf({ code: "challenge_required", readBefore: false }), "first_login");
  assert.equal(causeOf({ code: "login_redirect", readBefore: true }), "instagram", "prod 55 and 74, 10-12: 302 to login on every read");
  assert.equal(causeOf({ code: "instagram_session_killed", readBefore: true }), "instagram");
  assert.equal(causeOf({ code: "transport", readBefore: true }), "ours");
  assert.equal(causeOf({ code: "bad_password", readBefore: false }), "bad_password");
  assert.equal(causeOf({ code: null, readBefore: true }), "unknown");
});

test("estate reads: Grafana frames, the auth line and the miss value", () => {
  const table = [{ schema: { fields: [{ name: "a" }, { name: "b" }] }, data: { values: [[1, 2], ["x", "y"]] } }];
  assert.deepEqual(frameRows(table), [{ a: 1, b: "x" }, { a: 2, b: "y" }]);
  const series = [{ schema: { fields: [{ name: "Time" }, { name: "Value", labels: { cause: "instagram" } }] }, data: { values: [[1, 2], [3, 4]] } }];
  assert.deepEqual(frameSeries(series), [{ labels: { cause: "instagram" }, value: 4 }]);
  assert.equal(grafanaAuth('GRAFANA_ADMIN_USER=admin\nGRAFANA_ADMIN_PASSWORD="pw"\n'), `Basic ${Buffer.from("admin:pw").toString("base64")}`);
  assert.throws(() => grafanaAuth("GRAFANA_ADMIN_USER=admin\nGRAFANA_ADMIN_PASSWORD=encrypted:abc\n"), /encrypted/);
  assert.equal(missValue({ op: ">=", target: 100000 }), -UNMEASURED);
  assert.equal(missValue({ op: "<=", target: 2_000_000 }), 2_000_001);
});

test("add.ts stores both launch duties with the precheck cwd resolved to this component", async () => {
  const component = join(import.meta.dirname, "..");
  const dataDir = await mkdtemp(join(tmpdir(), "duty-add-"));
  try {
    for (const name of ["engage-reads", "watchlist-green"])
      await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/duties/add.ts", "chat1", join(component, "scripts", "duties", `${name}.duty.json`), "--data-dir", dataDir], { cwd: component });
    const duties = await new DutyStore(dataDir).list("chat1");
    assert.deepEqual(duties.map(duty => [duty.name, duty.precheck.cwd]), [["Engage reads scale safely", component], ["Watchlist shows green", component]]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
