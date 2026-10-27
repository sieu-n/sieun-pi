// Replays why d9's stuck_duties missed from 10-22 11:48Z to 17:03Z after p894. Of its 8 counts, 3 read a green duty as red: AI harness d11
// at 14:45Z and ops guy's d1 at 14:45Z and 15:03Z, whose newest reading was an older run's after-job measure that met every metric while d9
// took the newest run by start, a skipped verify run that missed. 4 sat red because the duty runner gave no push for up to a check-in interval
// after a cut job came back from its pool wait and ended with no after-job measure: AI harness d5 at 11:48Z, AI harness d9 at 16:03Z and
// metal-management's d1 at 16:03Z and 17:03Z. 1 was a duty job waiting on its subagent in pi-pool's queue: Prospect feature bro's d2 at 16:03Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutWorkingRuns } from "../scripts/duties/chat-system.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import { pushMisses } from "../src/duty-push.ts";
import type { DutyRunRecord, MetricResult } from "../src/shared/chat-duties.ts";

const MIN = 60_000;
const at = (clock: string) => Date.parse(`2026-10-22T${clock}Z`);
const off = (value: number): MetricResult => ({ value, target: 0, op: "<=", met: value <= 0 });
const OPS = "01a11af8-962e-773d-a19a-ee4104011987";
const PROSPECT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const empty = { v: 2, rev: 1, updatedAt: "2026-10-22T11:00:00Z", todos: [], plan: [] };
const inputs = (runs: DutyRunRecord[], now: number) => ({ now, chats: [{ id: OPS, name: "ops guy (+observability)", runs,
  duties: [{ id: "d1", name: "Local dev servers" }], paused: false, everyMs: 120 * MIN }], boards: new Map([[OPS, empty]]), ownerActivity: new Map(),
  waking: new Set<string>(), poolWaiting: new Set<string>(), named: new Map() }) as unknown as PlanInputs;

test("d9 judges a red duty on its newest reading by time, so an older run's newer after-job measure that met reads green (ops guy d1, 14:45Z)", () => {
  const pushed: DutyRunRecord = { duty: "d1", at: at("08:08:53"), trigger: "push", ms: 1, verdict: "met", summary: "",
    metrics: { servers_not_answering: off(0), mac_checks_failing: off(0) }, job: { id: "01a1609c", name: "local dev servers ops guy (+observability) 17:08" },
    after: { at: at("13:17:46"), verdict: "met", summary: "", metrics: { servers_not_answering: off(0), mac_checks_failing: off(0) } } };
  const skipped: DutyRunRecord = { duty: "d1", at: at("11:43:44"), trigger: "verify", ms: 1, verdict: "missed",
    summary: "servers_not_answering 1, mac_checks_failing 1; skipped: previous run still working", metrics: { servers_not_answering: off(1), mac_checks_failing: off(1) } };
  assert.equal(planCounts(inputs([skipped, pushed], at("14:45:19"))).redDuties.length, 0);
  const later = { ...skipped, at: at("14:30:00") };
  const older = { ...pushed, after: { ...pushed.after!, at: at("11:00:00") } };
  assert.equal(planCounts(inputs([later, older], at("14:45:19"))).redDuties.length, 1, "a skipped run newer than the after-job measure still reads red");
});

test("a duty whose cut job came back and ended gets its push at once, and a cut push run's rerun waits the interval (metal-management d1, 15:42Z)", () => {
  const cut = { error: "pi-pool: this session waits for its slot", at: at("15:23:28"), provider: "anthropic", slotAt: at("15:27:00") };
  const verify: DutyRunRecord = { duty: "d1", at: at("14:49:44"), trigger: "verify", ms: 1, verdict: "missed", summary: "", metrics: { tool_rows_off: off(1) },
    job: { id: "01a16417-3e73-70c9-ac76-83023e8e2e79", name: "box tools parity metal-management 23:49" }, cut };
  const rerun: DutyRunRecord = { duty: "d1", at: at("15:29:28"), trigger: "rerun", rerunOf: verify.at, ms: 1, verdict: "missed",
    summary: "tool_rows_off 2; skipped: previous run still working (job box tools parity metal-management 23:49)", metrics: { tool_rows_off: off(2) } };
  const counted = new Set(["tool_rows_off"]);
  assert.deepEqual(pushMisses([rerun, verify], counted, 120 * MIN, at("15:43:00")), ["tool_rows_off"]);
  const rerunJob: DutyRunRecord = { ...rerun, job: { id: "01a1641f", name: "box tools parity metal-management 00:29" }, cut: { ...cut, at: at("15:31:00") } };
  assert.deepEqual(pushMisses([rerunJob, verify], counted, 120 * MIN, at("15:43:00")), ["tool_rows_off"], "a cut rerun's job of a verify run counts the same (AI harness d9, 15:42Z)");
  const push = { ...verify, trigger: "push" as const };
  assert.equal(pushMisses([{ ...rerunJob, rerunOf: push.at }, push], counted, 120 * MIN, at("15:43:00")), null, "a cut push run's rerun waits the interval");
  const { cut: _cut, ...working } = verify;
  assert.equal(pushMisses([rerun, working], counted, 120 * MIN, at("15:43:00")), null, "a job with no measure and no cut still works");
});

test("d9 counts a duty job whose subagent waits in pi-pool's queue as at work (Prospect feature bro d2, 16:03Z)", () => {
  const job = { id: "01a1637c-e91a-70cf-ac20-e455b23c8b1c", name: "watchlist green Prospect feature bro 21:00" };
  const runs: DutyRunRecord[] = [{ duty: "d2", at: at("12:00:29"), trigger: "rerun", ms: 1, verdict: "missed", summary: "", metrics: { staging_green_pct: { value: 99.6, target: 100, op: ">=", met: false } }, job }];
  const rows = [{ sessionId: job.id, sessionName: job.name, activity: "idle", lastActivityAt: "2026-10-22T15:17:40.000Z" }];
  const stuck = [{ chat: PROSPECT, duty: "d2" }];
  assert.equal(withoutWorkingRuns(stuck, new Map([[PROSPECT, runs]]), rows, at("16:03:09")).length, 1);
  assert.equal(withoutWorkingRuns(stuck, new Map([[PROSPECT, runs]]), rows, at("16:03:09"), new Set(), new Set([job.id])).length, 0);
});
