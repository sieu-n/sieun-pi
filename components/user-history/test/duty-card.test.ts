import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dutyCard, jobLive, missStreak } from "../src/client/duty-card.ts";
import { CHECK_IN_DUTY, type DutyCard, type DutyRunRecord, type DutyView } from "../src/shared/chat-duties.ts";
import type { ChatAgent } from "../src/shared/types.ts";

/** Chat 01a1164b's Mac stays usable, Skills and tools and check-in duties with their last runs, read from its duty files on 10-15 at 17:22 KST. */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/duty-card-1015.json", import.meta.url), "utf8")) as {
  duties: DutyCard[]; runs: Record<string, DutyRunRecord[]>;
};
const view = (id: string, runs = fixture.runs[id]!): DutyView => ({
  duty: id === "checkin" ? { ...CHECK_IN_DUTY, status: "active" } : fixture.duties.find(duty => duty.id === id)!, ...(id === "checkin" ? { builtin: "checkin" as const } : {}),
  schedule: { kind: "every", minutes: 60 }, paused: false, nextAt: null, running: false, runs, priority: "high" });
const agent = (name: string, state: ChatAgent["state"]): ChatAgent => ({ key: `thread:${name}`, name, job: name, sender: name, link: "step", state, steps: [] });

test("Mac stays usable on 10-15: the headline missed once, the 24 h share 11 runs with no move is stuck, and no fix job works on either", () => {
  const card = dutyCard(view("d6"), []);
  assert.equal(card.headline, "Share of the last hour's minutes the Mac was usable 93.2%, target at least 100%, off target");
  assert.deepEqual(card.headlineMiss, { key: "usable_pct_1h", text: "Share of the last hour's minutes the Mac was usable 93.2%, target at least 100%", misses: 1, stuck: false, fix: { kind: "none" } });
  assert.deepEqual(card.misses.map(line => [line.key, line.text, line.misses, line.stuck, line.fix.kind]),
    [["usable_pct_24h", "Share of the last 24 hours' minutes the Mac was usable 96.7%, target at least 100%", 11, true, "none"]]);
  assert.deepEqual(card.onTarget, ["Longest run of unusable minutes in the last hour", "Minutes in the last hour with a working session quiet over 30 min",
    "Minutes in the last hour with a queued turn waiting over 706 s", "Background waiters in job kernels in the last hour"]);
  assert.equal(card.streak, 11);
  assert.deepEqual(card.job, { name: "mac stays usable AI harness developer environment 17:22", live: false });
  assert.equal(dutyCard(view("d6"), [agent("mac stays usable AI harness developer environment 17:22", "working")]).job?.live, true);
});

test("Skills and tools on 10-15: checks_failed missed 4 runs across a skipped slot and moved toward 0, so it is not stuck", () => {
  const card = dutyCard(view("d5"), []);
  assert.deepEqual(card.headlineMiss && [card.headlineMiss.key, card.headlineMiss.misses, card.headlineMiss.stuck], ["checks_failed", 4, false]);
  assert.deepEqual(card.misses.map(line => [line.key, line.misses]), [["cua_failed", 1], ["owner_fixes", 1]]);
  assert.equal(card.streak, 4);
});

test("check-in on 10-15: loose_goals missed 3 runs at 1 with no move, so the next run must change approach", () => {
  const card = dutyCard(view("checkin"), []);
  const loose = card.misses.find(line => line.key === "loose_goals");
  assert.deepEqual(loose && [loose.misses, loose.stuck], [3, true]);
  assert.equal(card.streak, 3);
});

test("the after-job measure is the card's verdict: a run whose job fixed both misses reads met with no miss lines", () => {
  const [newest, ...older] = fixture.runs.d6!;
  const met = Object.fromEntries(Object.entries(newest!.metrics).map(([key, result]) => [key, { ...result, value: result.target, met: true }]));
  const card = dutyCard(view("d6", [{ ...newest!, after: { at: newest!.at + 600_000, verdict: "met", metrics: met, summary: "all on target" } }, ...older]), []);
  assert.equal(card.headlineMiss, null);
  assert.deepEqual(card.misses, []);
  assert.equal(card.streak, 0);
  assert.match(card.headline ?? "", /100%, target at least 100%, met$/);
});

test("a fix job is live from the chat's agent rows, else from what the run saw; a fix with no working job is the gap", () => {
  const [newest, ...older] = fixture.runs.d6!;
  const runs = [{ ...newest!, fixes: { usable_pct_24h: { step: "p12", job: "mac usable fix", live: false } } }, ...older];
  const fix = (agents: ChatAgent[]) => dutyCard(view("d6", runs), agents).misses[0]!.fix;
  assert.deepEqual(fix([agent("mac usable fix", "working")]), { kind: "live", job: "mac usable fix", step: "p12" });
  assert.deepEqual(fix([agent("mac usable fix", "idle")]), { kind: "idle", job: "mac usable fix", step: "p12" });
  assert.deepEqual(fix([]), { kind: "idle", job: "mac usable fix", step: "p12" });
  assert.equal(jobLive("mac usable fix", [], true), true, "an unlisted job keeps the run's live flag");
  assert.equal(jobLive("x", [{ ...agent("x", "idle"), subagentsRunning: 2 }]), true, "subagents still working");
  assert.equal(missStreak([]), 0);
});
