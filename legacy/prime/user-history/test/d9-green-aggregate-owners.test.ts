// AI harness 11-20: d9's duties_green_pct read 66.6% with 23 red duties, missed 424 runs in a row, and every d9 run's brief told its job to start
// a fix job and add a plan step for it, while each red already had an owner d9's other metrics judge: a live fix job, the owner's For you todo,
// a count that ages out, a :5184 sw factory chat or its own duty's runs. The chat dropped p962 under c110, so each run was told to add a zombie step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSystemOutput, type ChatSystemFacts, type RedDuty, redOwners } from "../scripts/duties/chat-system.ts";
import { dutyJobBrief, missLine } from "../src/chat-duty-job.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";

const NOW = Date.parse("2026-11-20T02:32:00Z");
const red = (chat: string, duty: string, extra: Partial<RedDuty> = {}): RedDuty => ({ chat, duty, name: duty, green: false, misses: 4, stuck: false, ...extra });
const GREEN: DutyMetric = { key: "duties_green_pct", label: "Duties green in all chats", op: ">=", target: 100, unit: "%" };
// Today's shape: 5 live fixes, 8 on the owner, 4 aging, 4 sw factory, 2 pushed by their own duties' runs, none stuck.
const today: RedDuty[] = [
  ...["p283", "p361", "p360", "p356", "p746"].map((fix, index) => red(`live${index}`, "d1", { fix })),
  ...Array.from({ length: 8 }, (_, index) => red("crawler", `d${index + 1}`, { held: `p12${index} on t112` })),
  ...Array.from({ length: 4 }, (_, index) => red("harness", `d${index + 10}`, { agingSince: NOW - 3_600_000 })),
  ...Array.from({ length: 4 }, (_, index) => red("seo", `d${index + 1}`, { fix: "p130" })),
  red("slack", "d3"), red("crawler", "d5", { misses: 21 }),
];
const facts = (stuckDuties: ChatSystemFacts["stuckDuties"] = []): ChatSystemFacts => ({ names: new Map(), stuck: [], upkeep: [], fleet: { pct: 66.6, red: today },
  stuckDuties, idleGoals: [], followUps: [], detail: "/tmp/d9.md", noPush: new Set(["seo"]) });

test("d9 names the owner of every red duties_green_pct counts", () => {
  assert.deepEqual(redOwners(facts()), { live: 5, owner: 8, aging: 4, swFactory: 4, ownRuns: 2, none: 0 });
  assert.deepEqual(redOwners(facts([{ chat: "slack", duty: "d3", line: "slack green guy: d3 red, no live fix job" }])),
    { live: 5, owner: 8, aging: 4, swFactory: 4, ownRuns: 1, none: 1 }, "a stuck duty has no owner");
  const out = chatSystemOutput(facts());
  assert.equal(out.metrics.duties_green_pct, 66.6, "the green share stays in the verdict as read (c75)");
  assert.deepEqual(out.redOwners?.duties_green_pct, { live: 5, owner: 8, aging: 4, swFactory: 4, ownRuns: 2, none: 0 });
});

const STUCK: DutyMetric = { key: "stuck_duties", label: "Red duties with no live fix job", op: "<=", target: 0 };
const streaksOf = (output: ReturnType<typeof chatSystemOutput>) => {
  const judged = judge([GREEN, STUCK], output);
  const run: DutyRunRecord = { duty: "d9", at: NOW, trigger: "schedule", ms: 1, verdict: judged.verdict, metrics: judged.metrics, summary: judged.summary,
    fixes: { duties_green_pct: { step: "p1381", job: "d9 counts 5184 chats", live: false } } };
  return metricStreaks([run]).map(streak => ({ ...streak, misses: streak.key === GREEN.key ? 424 : 1 }));
};
const briefLine = (output: ReturnType<typeof chatSystemOutput>): string =>
  missLine("d9", streaksOf(output).find(entry => entry.key === GREEN.key)!, GREEN.label, GREEN.unit, NOW);
const brief = (output: ReturnType<typeof chatSystemOutput>): string => dutyJobBrief({ duty: { id: "d9", name: "Chat system", ownerWords: "(10-15, c75) why is duties not all passing?",
  goal: "Every chat keeps its duties green.", metrics: [GREEN, STUCK] }, chat: { id: "harness", name: "AI harness", board: "/tmp/data/boards/harness.json" },
  job: "d9 test", at: NOW, measure: "duties_green_pct 66.6%", findings: "", misses: streaksOf(output) });

test("a duties_green_pct miss whose every red is owned starts no job and adds no step", () => {
  const line = briefLine(chatSystemOutput(facts()));
  assert.match(line, /duties_green_pct \(Duties green in all chats\) is 66\.6%, target >= 100%, missed 424 runs in a row/);
  assert.match(line, /5 with a live fix job, 8 waiting on the owner's For you todo, 4 aging out of a trailing window, 4 in :5184 chats sw factory runs, 2 pushed by their own duty's runs/);
  assert.match(line, /Start no job and add no plan step for it, and give p1381 no successor when it closes; push the chats on the push list/);
  assert.doesNotMatch(line, /rlm\.create_session|Change approach/);
});

test("a duties_green_pct miss with a stuck red still asks for a fix job", () => {
  const line = briefLine(chatSystemOutput(facts([{ chat: "slack", duty: "d3", line: "slack green guy: d3 red, no live fix job" }])));
  assert.match(line, /rlm\.create_session/);
  assert.doesNotMatch(line, /Every red it counts has an owner/);
});

test("a precheck's redOwners entry with a bad count is dropped", () => {
  const bad = judge([GREEN], { metrics: { duties_green_pct: 50 }, redOwners: { duties_green_pct: { live: 1, owner: -1, aging: 0, swFactory: 0, ownRuns: 0, none: 0 } } });
  assert.equal(bad.metrics.duties_green_pct?.redOwners, undefined);
});

test("the missed metrics header follows the same owner rule as the line", () => {
  const owned = brief(chatSystemOutput(facts()));
  assert.match(owned, /## Missed metrics: every red they count has an owner, so they need no fix step of this chat\n/);
  assert.match(owned, /Such a miss still reads as not ok: this run moves it through the push list/);
  assert.doesNotMatch(owned, /each one needs a fix step with a live job|A miss is never accepted as it stands/);
  const stuck = [{ chat: "slack", duty: "d3", line: "slack green guy: d3 red, no live fix job" }];
  const unowned = brief(chatSystemOutput(facts(stuck)));
  assert.match(unowned, /## Missed metrics: each one needs a fix step with a live job\n/);
  assert.match(unowned, /A miss is never accepted as it stands/);
  const mixed = { ...chatSystemOutput(facts()), metrics: { ...chatSystemOutput(facts()).metrics, stuck_duties: 1 } };
  assert.match(brief(mixed), /## Missed metrics: each one needs a fix step with a live job, except where its line says every red it counts has an owner\n/);
});
