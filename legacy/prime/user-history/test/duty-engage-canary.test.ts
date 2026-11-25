// Guards d1's canary read. On 2026-10-18 at 05:21Z the Engage reads scale safely precheck said no canary ran, because it read engage.rate_test_arms,
// which prod leaves empty on purpose, while 15 of 169 active prod accounts ran the hash cohort engage.canary_pct 10, engage.canary_offset 65
// (config_audit 13970 and 13994) at 2,000 pages a day. auto-sns-agent 4012d607b9 moved the canary to the id roster engage.canary_accounts, which
// the crawler's roster keeper sizes by engage.canary_roster_pct, so d1 reads only the roster since 11-24.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Account, type EngageData, canaryOf, report, rosterChangesOf, stagingOverdueOf } from "../scripts/duties/engage-reads.ts";

/** Prod's 200 accounts on 10-18 05:40Z; the ones not listed in NOT_ACTIVE are active. */
const IDS = "11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,219,220,221,222,223,224,225,226,227,228,230,231,232,237,241,242,243,244,245,246,249,251,252,253,254,255,257,260,261,262,264,265,267,268,269,270,271,272,273,274,275,277".split(",").map(Number);
const NOT_ACTIVE: Record<string, string> = {"11": "challenged", "17": "challenged", "19": "challenged", "20": "frozen", "32": "challenged", "36": "challenged", "37": "challenged", "38": "disabled", "39": "challenged", "40": "frozen", "43": "challenged", "45": "disabled", "53": "challenged", "55": "disabled", "58": "challenged", "61": "challenged", "62": "challenged", "68": "challenged", "70": "disabled", "71": "disabled", "72": "disabled", "73": "parked", "74": "disabled", "75": "parked", "203": "disabled", "226": "disabled", "230": "disabled", "262": "challenged", "265": "disabled", "267": "challenged", "272": "disabled"};
const ACCOUNTS: Account[] = IDS.map(id => ({ id, status: NOT_ACTIVE[id] ?? "active" }));
const NOW = Date.parse("2026-10-18T06:00:00Z");
const ROSTER = "17,22,35,40,58,63,117,122,135,140,158,163,176,181,199,204,217,222";
const CONFIG = { "engage.canary_accounts": ROSTER, "engage.canary_started_at": "2026-10-15T13:47:45+00:00", "engage.canary_stop_deaths": "3" };

const run = (config: Record<string, string>): ReturnType<typeof report> => report({
  now: NOW, accounts: ACCOUNTS, config, errors: [],
  days: [{ day: "2026-10-17", accountId: 22, pages: 1900 }, { day: "2026-10-17", accountId: 35, pages: 1500 }, { day: "2026-10-17", accountId: 100, pages: 800 }],
  deaths: [{ accountId: 22, at: NOW - 30 * 60_000, status: "challenged", code: "challenge_required", readBefore: true, pages24h: 1900, transition: true }],
} satisfies EngageData, []);
const canaryLine = (output: ReturnType<typeof report>): string => (output.flagged ?? []).find(flag => flag.kind === "canary" || flag.kind === "canary_short")!.excerpt;

test("the roster engage.canary_accounts is the canary, and d1 counts its live members with their pages and deaths", () => {
  const output = run(CONFIG);
  const line = canaryLine(output);
  assert.match(line, /^canary from engage.canary_accounts, started 10-15 13:47Z: 15 of 169 active prod accounts \(18 in it with the dead\)/);
  assert.match(line, /they read 3,400 pages on 2026-10-17, the busiest 1,900/);
  assert.match(line, /Instagram killed 1 of them in 24 h, at most 1 in any 60 minutes, and 1 since the start \(the canary stops at 3\)/);
  assert.match(line, /add 2 active accounts through engage.canary_roster_pct$/);
  assert.equal(output.metrics.canary_accounts_short, 2);
  assert.equal(output.metrics.canary_ig_deaths_1h, 1);
  assert.equal(output.metrics.fleet_ig_killed_pct, 0);
});

test("an empty roster names engage.canary_roster_pct, the key the crawler's roster keeper sizes it by, and not the retired hash keys", () => {
  // 11-24 07:00Z: d1 said "engage.canary_pct is 0" while an 11-20 canary_roster_pct row of 0 had emptied the roster (prod audit 49120).
  assert.equal(canaryOf({ ...CONFIG, "engage.canary_accounts": "", "engage.canary_roster_pct": "0" }).empty,
    'engage.canary_accounts is empty and engage.canary_roster_pct reads "0"');
  const output = run({ ...CONFIG, "engage.canary_accounts": "" });
  assert.match(canaryLine(output), /^no canary runs: engage.canary_accounts is empty and engage.canary_roster_pct reads its default \(empty row\)/);
  assert.match(canaryLine(output), /add 17 active accounts through engage.canary_roster_pct$/);
});

test("no canary runs without engage.canary_started_at, and a death then counts against the fleet", () => {
  const output = run({ ...CONFIG, "engage.canary_started_at": "" });
  assert.match(canaryLine(output), /^no canary runs: engage.canary_accounts names accounts, but engage.canary_started_at "" is empty/);
  assert.equal(output.metrics.canary_accounts_short, 17);
  assert.equal(output.metrics.fleet_ig_killed_pct, 0.6);
});

test("a daily run sees the worst canary hour of its day, and a canary holding every reader is flagged", () => {
  // Instagram suspended 24 canary accounts, every account that read, from 23:13Z 11-18, and the 09:00Z 11-19 run read 0 for both.
  const now = Date.parse("2026-11-19T09:00:00Z");
  const dead = Array.from({ length: 24 }, (_, i) => 300 + i);
  const accounts: Account[] = [...dead.map(id => ({ id, status: "frozen" })), ...Array.from({ length: 116 }, (_, i) => ({ id: 400 + i, status: "active" }))];
  const deaths = dead.map((accountId, i) => ({ accountId, at: Date.parse("2026-11-18T23:13:00Z") + i * 120_000, status: "frozen", code: "account_suspended", readBefore: true, pages24h: 539, transition: true }));
  const output = report({ now, accounts, deaths, errors: [], days: dead.map(accountId => ({ day: "2026-11-18", accountId, pages: 1100 })),
    config: { "engage.canary_accounts": dead.join(","), "engage.canary_started_at": "2026-11-01T00:00:00Z" } } satisfies EngageData, []);
  assert.equal(output.metrics.canary_ig_deaths_1h, 24);
  assert.equal(output.metrics.fleet_ig_killed_pct, 0);
  const oversize = (output.flagged ?? []).find(flag => flag.kind === "canary_oversize");
  assert.equal(oversize?.handOff, true);
  assert.match(oversize!.excerpt, /^the canary holds 24 of the 24 prod accounts that read on 2026-11-18 UTC, and ~10% is 2/);
});

test("the staging stall counts the collab reads staging's crawler counts overdue, not the rows paid_only refuses", () => {
  // 11-24: staging /ops/watch-targets/health read overdue_24h tagged 0 with 413 due, while d1's own SQL flagged 369 house rows as a 5,547 min stall.
  const health = { ok: true, data: { overdue_24h: { posts: 2233077, tagged: 0 }, due_now: { posts: 2238942, tagged: 413 } } };
  assert.deepEqual(stagingOverdueOf(health), { overdue: 0, due: 413 });
  const stall = (overdue: number) => report({ now: NOW, accounts: ACCOUNTS, config: CONFIG, errors: [], deaths: [], stagingPauses: [], stagingLastReadAt: NOW - 60_000,
    stagingOverdue: { overdue, due: 413 } } satisfies EngageData, []);
  assert.equal(stall(0).flagged?.some(flag => flag.kind === "staging_stall"), false);
  assert.equal(stall(0).metrics.staging_tagged_overdue_24h, 0);
  assert.match(stall(5).flagged!.find(flag => flag.kind === "staging_stall")!.excerpt, /^staging's crawler counts 5 collab reads overdue past 24 h \(target 0, 413 due now\)/);
  assert.throws(() => stagingOverdueOf({ ok: false }), /staging watch health: unexpected answer/);
});

test("a canary member the roster keeper drops between its last page and its death counts as a canary death, not a fleet kill", () => {
  // 11-25: prod 242 read its last canary page at 14:06:28Z, left the roster by audit 49190 at 14:07:42Z, and went relogin_gone at 14:08:25Z.
  const now = Date.parse("2026-11-25T14:20:00Z");
  const accounts: Account[] = [{ id: 242, status: "disabled" }, ...Array.from({ length: 49 }, (_, i) => ({ id: 600 + i, status: "active" }))];
  const config = { "engage.canary_accounts": "18,279,15,245,232,270,227,249,261", "engage.canary_started_at": "2026-11-20T00:17:33Z" };
  const rosterChanges = rosterChangesOf([{ at: Date.parse("2026-11-25T14:07:42Z"), old_value: "18,279,15,245,242,232,270,227,249", new_value: config["engage.canary_accounts"] }]);
  const death = { accountId: 242, at: Date.parse("2026-11-25T14:08:25Z"), status: "disabled", code: "relogin_gone", readBefore: true, pages24h: 1106, transition: true };
  const run = (lastReadAt: number | null) => report({ now, accounts, config, errors: [], days: [], rosterChanges,
    deaths: [{ ...death, lastReadAt }] } satisfies EngageData, []);
  const kept = run(Date.parse("2026-11-25T14:06:28Z"));
  assert.equal(kept.metrics.fleet_ig_killed_pct, 0);
  assert.equal(kept.metrics.canary_ig_deaths_1h, 1);
  assert.match(kept.flagged!.find(flag => flag.kind === "death")!.excerpt, /cause instagram, canary,/);
  assert.equal(run(null).metrics.fleet_ig_killed_pct, 2);
});
