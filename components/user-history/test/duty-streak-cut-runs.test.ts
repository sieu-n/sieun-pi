// Guards d11 of the AI harness chat on 10-21: its 21:31Z verify run and that run's 01:32Z rerun both had their jobs cut by pi-pool slot waits
// ("token hook gave no token (credential_unavailable)"), so they labelled nothing, yet each read unlabeled_lines 3 and 6 after its job, and the
// 02:32Z push run was told "missed 3 runs in a row, change approach". Its job then waited 6.5 h for a slot of its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { missStreak as cardStreak } from "../src/client/duty-card.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import { metricStreaks, missStreak, streakRuns } from "../src/shared/duty-streak.ts";

const metrics: DutyMetric[] = [
  { key: "needed_pct_24h", label: "Owner messages he needed, last 24 h", op: ">=", target: 90 },
  { key: "unlabeled_lines", label: "Owner message lines with no label", op: "<=", target: 0 },
];
const t = (iso: string): number => Date.parse(iso);
const measure = (at: string, needed: number, unlabeled: number) => ({ at: t(at), ...judge(metrics, { metrics: { needed_pct_24h: needed, unlabeled_lines: unlabeled } }) });
const cut = (at: string, slot: string) => ({ error: `token hook gave no token (credential_unavailable): pi-pool: this session waits for its slot at ${slot}.`, at: t(at), provider: "anthropic", slotAt: t(slot) });

function run(at: string, trigger: DutyRunRecord["trigger"], needed: number, unlabeled: number, extra: Partial<DutyRunRecord> = {}): DutyRunRecord {
  const { metrics: results, verdict, summary } = measure(at, needed, unlabeled);
  return { duty: "d11", at: t(at), trigger, ms: 1, verdict, metrics: results, summary, ...extra };
}

/** d11's runs file at the start of the 02:32Z push run, newest first: the push run itself, then the three runs before it. */
const runs1021 = (): DutyRunRecord[] => [
  run("2026-10-21T02:32:54Z", "push", 82.1, 6),
  run("2026-10-21T01:32:34Z", "rerun", 80, 3, { rerunOf: t("2026-10-20T21:31:27Z"), cut: cut("2026-10-21T01:47:41Z", "2026-10-21T01:54:00Z"),
    after: measure("2026-10-21T02:32:54Z", 82.1, 6) }),
  run("2026-10-20T21:31:27Z", "verify", 80.5, 0, { cut: cut("2026-10-20T22:26:30Z", "2026-10-20T22:29:00Z"), after: measure("2026-10-21T01:32:34Z", 80, 3) }),
  run("2026-10-20T21:03:14Z", "schedule", 80.5, 1, { cut: cut("2026-10-20T21:03:27Z", "2026-10-20T21:12:00Z"), after: measure("2026-10-20T21:31:27Z", 80.5, 0) }),
];

test("cut runs do not extend the miss streak, so d11's 02:32Z push run is told about one miss, not three", () => {
  const unlabeled = metricStreaks(runs1021()).find(streak => streak.key === "unlabeled_lines");
  assert.equal(unlabeled?.misses, 1);
  assert.equal(unlabeled?.stuck, false);
  assert.equal(missStreak(runs1021()), 1);
  assert.equal(cardStreak(runs1021(), metrics), 1);
});

test("a cut run that read met after its job does not break a streak", () => {
  const runs = [
    run("2026-10-21T04:00:00Z", "schedule", 80, 4),
    run("2026-10-21T03:00:00Z", "schedule", 80, 4, { cut: cut("2026-10-21T03:00:10Z", "2026-10-21T03:10:00Z"), after: measure("2026-10-21T04:00:00Z", 95, 0) }),
    run("2026-10-21T02:00:00Z", "schedule", 80, 4, { after: measure("2026-10-21T03:00:00Z", 80, 4) }),
    run("2026-10-21T01:00:00Z", "schedule", 80, 4, { after: measure("2026-10-21T02:00:00Z", 80, 4) }),
  ];
  assert.deepEqual(streakRuns(runs).map(entry => entry.at), [runs[0]!.at, runs[2]!.at, runs[3]!.at]);
  const unlabeled = metricStreaks(runs).find(streak => streak.key === "unlabeled_lines");
  assert.equal(unlabeled?.misses, 3);
  assert.equal(unlabeled?.stuck, true);
});

test("the newest run counts even when its job was cut, since it reads the duty's state now", () => {
  const [newest, ...older] = runs1021().slice(1);
  const streaks = metricStreaks([newest!, ...older]);
  assert.equal(streaks.find(streak => streak.key === "unlabeled_lines")?.misses, 1);
  assert.equal(streaks.find(streak => streak.key === "unlabeled_lines")?.value, 6);
  assert.equal(cardStreak([newest!, ...older], metrics), 1);
});

test("a rerun whose job did its work counts like any run", () => {
  const runs = runs1021();
  delete runs[1]!.cut;
  assert.equal(metricStreaks(runs).find(streak => streak.key === "unlabeled_lines")?.misses, 2);
});
