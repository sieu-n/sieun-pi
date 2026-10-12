import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DutyStore } from "../src/chat-duty-store.ts";
import { type DutyMetric, judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { type Account, type EngageData, canaryRoster, causeOf, measure, parseArms, report } from "../scripts/duties/engage-reads.ts";
import { UNMEASURED, frameRows, frameSeries, grafanaAuth, missValue } from "../scripts/duties/estate-reads.ts";

const NOW = Date.parse("2026-10-12T14:00:00Z");
const MIN = 60_000;
const FILE = join(import.meta.dirname, "..", "scripts", "duties", "engage-reads.duty.json");
const dutyMetrics = async (): Promise<DutyMetric[]> => parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW).metrics;
const account = (id: number, fields: Partial<Account> = {}): Account =>
  ({ id, status: "active", diedAt: null, deathCode: null, evented: false, readBefore: true, read24h: true, ...fields });

function data(fields: Partial<EngageData> = {}): EngageData {
  const accounts = [...Array.from({ length: 18 }, (_, index) => account(index + 1)), account(19, { read24h: false }), account(20, { read24h: false })];
  return { now: NOW, errors: [], prod: { pages24h: 120_000, pages1h: 5000, lastReadAt: NOW - 2 * MIN }, staging: { pages24h: 6000, pages1h: 60, lastReadAt: NOW - 5 * MIN },
    accounts, config: { "engage.rate_test_arms": "50:1;800:2", "engage.rate_test_started_at": "2026-10-12T03:00:00+00:00" }, ...fields };
}

test("engage reads: the duty file parses, its name passes c38, and the precheck writes every metric key", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "every", minutes: 60 });
  assert.equal(duty.precheck.cwd, "../..");
  const output = report(data(), duty.metrics);
  assert.deepEqual(Object.keys(output.metrics).sort(), duty.metrics.map(metric => metric.key).sort());
});

test("engage reads: a healthy fleet with a 10% canary meets every target", async () => {
  const metrics = await dutyMetrics();
  const output = report(data(), metrics);
  assert.equal(output.metrics.prod_reading_pct, 90);
  assert.equal(output.metrics.canary_accounts_short, 0);
  assert.equal(judge(metrics, output).verdict, "met");
});

test("engage reads: deaths split by cause and by canary, and a stopped prod is flagged", async () => {
  const accounts = [
    account(1, { status: "challenged", diedAt: NOW - 30 * MIN, deathCode: "challenge_required", evented: true }),
    account(2, { status: "disabled", diedAt: NOW - 3 * 60 * MIN, deathCode: "account_suspended", evented: true }),
    account(3, { status: "frozen", diedAt: NOW - 60 * MIN + 1, deathCode: "transport", evented: true }),
    account(4, { status: "frozen", diedAt: NOW - 10 * MIN, evented: true }),
    account(5, { status: "challenged", diedAt: NOW - 10 * MIN, deathCode: "challenged", evented: true, readBefore: false }),
    account(6, { status: "disabled", diedAt: NOW - 25 * 60 * MIN, deathCode: "challenged", evented: true }),
    ...Array.from({ length: 10 }, (_, index) => account(10 + index)),
  ];
  const output = report(data({ accounts, prod: { pages24h: 4, pages1h: 0, lastReadAt: NOW - 600 * MIN },
    config: { "engage.rate_test_arms": "50:1,3;800:10", "engage.rate_test_started_at": "2026-10-12T03:00:00Z", "pause.engage_tagged": "true" } }), await dutyMetrics());
  assert.equal(output.metrics.canary_ig_deaths_1h, 1, "account 1 is canary and Instagram's; 3 is ours");
  assert.equal(output.metrics.fleet_ig_deaths_24h, 1, "account 2 only: 4 has no code, 5 never read, 6 is older than 24 h");
  assert.equal(output.metrics.prod_last_read_min, 600);
  assert.equal(output.metrics.canary_accounts_short, 0, "1 of 10 active accounts is in the roster");
  const kinds = output.flagged!.map(item => item.kind);
  assert.ok(kinds.includes("prod_stopped") && kinds.includes("pause"));
  assert.equal(kinds.filter(kind => kind === "death").length, 5);
});

test("engage reads: a failed source reports source_errors and a value that misses, never a fake good one", async () => {
  const metrics = await dutyMetrics();
  const { accounts: _accounts, ...rest } = data();
  const output = report({ ...rest, errors: [{ source: "prod accounts", message: "permission denied for table ig_engage_accounts" }] }, metrics);
  assert.equal(output.metrics.source_errors, 1);
  assert.equal(output.metrics.prod_reading_pct, -UNMEASURED);
  assert.equal(output.metrics.fleet_ig_deaths_24h, UNMEASURED);
  assert.equal(output.metrics.prod_pages_24h, 120_000);
  assert.ok(output.flagged!.some(item => item.kind === "unmeasured"));
  assert.equal(judge(metrics, output).verdict, "missed");
});

test("engage reads: no Grafana login still gives a value for every metric", async () => {
  const metrics = await dutyMetrics();
  const output = report(await measure(null, "GRAFANA_ADMIN_PASSWORD is missing", NOW), metrics);
  assert.deepEqual(Object.keys(output.metrics).sort(), metrics.map(metric => metric.key).sort());
  assert.equal(output.metrics.source_errors, 5);
  assert.notEqual(judge(metrics, output).verdict, "error");
});

test("engage reads: the roster parser and the cause rule match rate_test.py and engage_deaths.py", () => {
  assert.deepEqual(parseArms("50:101,102; 800:103"), [{ dailyPages: 50, ids: [101, 102] }, { dailyPages: 800, ids: [103] }]);
  assert.throws(() => parseArms("50:1;80:1"), /twice/);
  assert.throws(() => parseArms("0:1"), /above 0/);
  assert.throws(() => parseArms("50"), /form/);
  assert.equal(canaryRoster({}, NOW).ids.size, 0);
  assert.equal(canaryRoster({ "engage.rate_test_arms": "50:1", "engage.rate_test_started_at": "2026-10-12T15:00:00Z" }, NOW).ids.size, 0, "a start in the future runs nothing yet");
  assert.equal(canaryRoster({ "engage.rate_test_arms": "50:1", "engage.rate_test_started_at": "2026-10-12T03:00:00" }, NOW).ids.size, 0, "a start with no offset is refused");
  assert.match(canaryRoster({ "engage.rate_test_arms": "x:1", "engage.rate_test_started_at": "2026-10-12T03:00:00Z" }, NOW).note, /refused/);
  assert.equal(causeOf({ deathCode: "challenge_required", evented: true, readBefore: true }), "instagram");
  assert.equal(causeOf({ deathCode: "challenge_required", evented: true, readBefore: false }), "first_login");
  assert.equal(causeOf({ deathCode: "transport", evented: true, readBefore: true }), "ours");
  assert.equal(causeOf({ deathCode: "bad_password", evented: true, readBefore: false }), "bad_password");
  assert.equal(causeOf({ deathCode: null, evented: true, readBefore: true }), "unknown");
  assert.equal(causeOf({ deathCode: "challenged", evented: false, readBefore: true }), "unknown");
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
