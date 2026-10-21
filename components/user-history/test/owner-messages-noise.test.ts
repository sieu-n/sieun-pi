// d11's first run, 06:03 KST on 10-21 (21:03Z on 10-20), read needed_pct_24h 80.5% on 8 noise lines from the night of 10-19 to 10-20, and its
// miss line asked for a fix job. noise-split.ts marks each line before or after the tell_owner check for its kind, so a miss on lines that only
// wait to leave the 24 h reads quiet a run later, says to start no new job, and d9 reads d11 as aging out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agingSince } from "../scripts/duties/chat-system.ts";
import { noiseLastEvent, noiseMetrics, noiseSide, splitNoise } from "../scripts/duties/noise-split.ts";
import { missLine } from "../src/chat-duty-job.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";

const at = Date.parse;
const commits: Record<string, string> = { f4092cd3: "2026-10-19T21:02:11Z", f45b220c: "2026-10-20T01:52:56Z", db253d1c: "2026-10-20T04:12:14Z", d7112574: "2026-10-20T07:39:05Z" };
const commitTime = async (hash: string) => commits[hash] ? at(commits[hash]!) : undefined;
const firstRun = at("2026-10-20T21:03:00Z");
const nightLines = [
  { at: at("2026-10-19T23:10:51Z"), case: "split answer (Mac chat on a pre-f4092cd build)" },
  { at: at("2026-10-20T02:44:44Z"), case: "repeat of a decision already on For you (t4)" },
  { at: at("2026-10-20T03:07:19Z"), case: "re-ask of an open For you todo (t4)" },
  { at: at("2026-10-20T03:14:59Z"), case: "re-ask of an open For you todo (t4)" },
  { at: at("2026-10-20T01:33:31Z"), case: "second report on a goal already reported" },
  { at: at("2026-10-19T21:46:23Z"), case: "second report on a goal already reported" },
  { at: at("2026-10-20T04:15:35Z"), case: "incident status sent as blocker" },
];
const metric: DutyMetric = { key: "needed_pct_24h", label: "Messages to the owner in the last 24 h that he needed, in percent", op: ">=", target: 90, headline: true };

test("the night's noise lines all went out before their kind's fix, the Mac's split answer by its pre-f4092cd build", async () => {
  const split = await splitNoise(nightLines, commitTime);
  assert.deepEqual(split.map(line => line.side), Array(7).fill("before_fix"));
  assert.equal(noiseSide(split[0]!), "before fix f4092cd3 of 10-19 21:02Z");
  assert.deepEqual(noiseLastEvent(split, firstRun), { needed_pct_24h: at(commits.d7112574!) });

  const output = { metrics: { needed_pct_24h: 80.5, ...noiseMetrics(split) }, lastEventAt: noiseLastEvent(split, firstRun) };
  const run = (time: number): DutyRunRecord => ({ duty: "d11", at: time, trigger: "schedule", ms: 1, ...judge([metric], output) });
  const runs = [run(firstRun + 30 * 60_000), run(firstRun)];
  const [streak] = metricStreaks(runs);
  assert.equal(streak!.quietSince, at(commits.d7112574!));
  assert.match(missLine("d11", streak!, metric.label, "%"), /moves toward its target as older events leave its window\. Start no new job for it/);
  assert.equal(agingSince(runs), at(commits.d7112574!));
});

test("a noise line that went out after its kind's fix, or of a kind no fix covers, keeps the miss live", async () => {
  const later = [...nightLines, { at: at("2026-10-20T16:48:37Z"), case: "second report on a goal already reported (later demo work on staging)" }, { at: at("2026-10-20T05:00:00Z"), case: "progress relay" }];
  const split = await splitNoise(later, commitTime);
  assert.deepEqual(noiseMetrics(split), { noise_before_fix_24h: 7, noise_after_fix_24h: 1, noise_no_fix_24h: 1 });
  assert.deepEqual(noiseLastEvent(split, firstRun), { needed_pct_24h: firstRun });
  const output = { metrics: { needed_pct_24h: 77.8 }, lastEventAt: noiseLastEvent(split, firstRun + 30 * 60_000) };
  const runs = [{ duty: "d11", at: firstRun + 30 * 60_000, trigger: "schedule" as const, ms: 1, ...judge([metric], output) },
    { duty: "d11", at: firstRun, trigger: "schedule" as const, ms: 1, ...judge([metric], { ...output, lastEventAt: { needed_pct_24h: firstRun } }) }];
  assert.equal(metricStreaks(runs)[0]!.quietSince, undefined);
  assert.equal(agingSince(runs), undefined);
});

test("the 10-21 restart asks of launch main bro and metal-management went out before the same-ask fix", async () => {
  const fixed = { ...commits, b084c910: "2026-10-21T09:40:55Z" };
  const split = await splitNoise([
    { at: at("2026-10-21T06:02:09Z"), case: "same incident asked again by another chat (prod crawler restart already asked on t56)" },
    { at: at("2026-10-21T11:00:00Z"), case: "same incident asked again by another chat" },
  ], async hash => fixed[hash as keyof typeof fixed] ? at(fixed[hash as keyof typeof fixed]!) : undefined);
  assert.deepEqual(split.map(line => [line.side, line.fix]), [["before_fix", "b084c910"], ["after_fix", "b084c910"]]);
});

test("no noise line gives no lastEventAt", () => {
  assert.deepEqual(noiseLastEvent([], firstRun), {});
});
