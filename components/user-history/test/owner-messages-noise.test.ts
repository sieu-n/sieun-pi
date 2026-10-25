// d11's first run, 06:03 KST on 10-21 (21:03Z on 10-20), read needed_pct_24h 80.5% on 8 noise lines from the night of 10-19 to 10-20, and its
// miss line asked for a fix job. noise-split.ts marks each line before or after the tell_owner check for its kind, so a miss on lines that only
// wait to leave the 24 h reads quiet a run later, says to start no new job, and d9 reads d11 as aging out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agingSince } from "../scripts/duties/chat-system.ts";
import { noiseAging, noiseLastEvent, noiseMetrics, noiseSide, splitNoise } from "../scripts/duties/noise-split.ts";
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
  assert.deepEqual(noiseLastEvent(split), { needed_pct_24h: at(commits.d7112574!) });

  const output = { metrics: { needed_pct_24h: 80.5, ...noiseMetrics(split) }, lastEventAt: noiseLastEvent(split) };
  const run = (time: number): DutyRunRecord => ({ duty: "d11", at: time, trigger: "schedule", ms: 1, ...judge([metric], output) });
  const runs = [run(firstRun + 30 * 60_000), run(firstRun)];
  const [streak] = metricStreaks(runs);
  assert.equal(streak!.quietSince, at(commits.d7112574!));
  assert.match(missLine("d11", streak!, metric.label, "%"), /moves toward its target as older events leave its window\. Start no new job for it/);
  assert.equal(agingSince(runs), at(commits.d7112574!));
});

test("a noise line that went out after its kind's fix, or of a kind no fix covers, reads live on the run after its label", async () => {
  const leak = at("2026-10-20T21:20:00Z"), labelled = firstRun + 40 * 60_000;
  const later = [...nightLines, { at: leak, labelled, case: "second report on a goal already reported (later demo work on staging)" }, { at: at("2026-10-20T05:00:00Z"), labelled: firstRun + 5 * 60_000, case: "progress relay" }];
  const split = await splitNoise(later, commitTime);
  assert.deepEqual(noiseMetrics(split), { noise_before_fix_24h: 7, noise_after_fix_24h: 1, noise_no_fix_24h: 1 });
  assert.deepEqual(noiseLastEvent(split), { needed_pct_24h: labelled });
  const output = { metrics: { needed_pct_24h: 77.8 }, lastEventAt: noiseLastEvent(split) };
  const runs = [{ duty: "d11", at: firstRun + 60 * 60_000, trigger: "schedule" as const, ms: 1, ...judge([metric], output) },
    { duty: "d11", at: firstRun + 30 * 60_000, trigger: "schedule" as const, ms: 1, ...judge([metric], output) }];
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

test("the 10-22 progress relays went out before the still-going fix, and a later one reads after it", async () => {
  const fixed = { ...commits, "208a7bb5": "2026-10-22T08:04:48Z" };
  const split = await splitNoise([
    { at: at("2026-10-22T06:30:16Z"), case: "progress relay (interim numbers 28 min before the final answer)" },
    { at: at("2026-10-19T20:19:52Z"), case: "progress on a goal still going" },
    { at: at("2026-10-22T10:00:00Z"), case: "progress relay" },
  ], async hash => fixed[hash as keyof typeof fixed] ? at(fixed[hash as keyof typeof fixed]!) : undefined);
  assert.deepEqual(split.map(line => [line.side, line.fix]), [["before_fix", "208a7bb5"], ["before_fix", "208a7bb5"], ["after_fix", "208a7bb5"]]);
});

test("the 10-23 Usage hang relay and the p57 staging done went out before the checks that refuse them, and a later one reads after", async () => {
  // ff9ba241 refuses "the fix is underway (p932)" and 97e7663f refuses a done for a step on staging; a replay of the live release over the
  // 2,732 lines sent from 10-09 to 10-23 14:30Z refuses both and no needed line (~/work/tell-owner-unasked-p957/replay.md).
  const fixed = { ...commits, "208a7bb5": "2026-10-22T08:04:48Z", ff9ba241: "2026-10-23T13:39:00Z", "97e7663f": "2026-10-23T14:12:39Z" };
  const split = await splitNoise([
    { at: at("2026-10-23T04:46:21Z"), case: "progress relay (cause of the Usage chart hang with its fix still underway, p932, sent on a child-failed wake)" },
    { at: at("2026-10-23T10:17:58Z"), case: "progress on a goal still going (p57 Google search step on staging while his goal p18 stays open)" },
    { at: at("2026-10-23T15:00:00Z"), case: "progress relay" },
  ], async hash => fixed[hash as keyof typeof fixed] ? at(fixed[hash as keyof typeof fixed]!) : undefined);
  assert.deepEqual(split.map(line => [line.side, line.fix]), [["before_fix", "ff9ba241"], ["before_fix", "97e7663f"], ["after_fix", "ff9ba241"]]);
});

test("the 10-23 unasked results p917 and p927 went out before the tell_owner description fix, and a later one reads after it", async () => {
  const fixed = { ...commits, "41665689": "2026-10-23T14:58:07Z" };
  const split = await splitNoise([
    { at: at("2026-10-23T04:01:35Z"), case: "unasked result (Prompt window speed fix p917 he did not ask for)" },
    { at: at("2026-10-23T04:04:49Z"), case: "unasked result (Prime update hello time p927 he did not ask for)" },
    { at: at("2026-10-23T15:00:00Z"), case: "unasked result" },
  ], async hash => fixed[hash as keyof typeof fixed] ? at(fixed[hash as keyof typeof fixed]!) : undefined);
  assert.deepEqual(split.map(line => [line.side, line.fix]), [["before_fix", "41665689"], ["before_fix", "41665689"], ["after_fix", "41665689"]]);
});

test("the 10-24 p954 unasked result went out before the open goal done check, and a later one reads after it", async () => {
  // 62ca6828 refuses a done for any step under an open goal that misses its target, which p954 was (p700 read 1 of 0), on its first call.
  const fixed = { ...commits, "41665689": "2026-10-23T14:58:07Z", "62ca6828": "2026-10-24T22:46:37Z" };
  const split = await splitNoise([
    { at: at("2026-10-24T21:29:53Z"), case: "unasked result (p954 Mac heavy checks on us-metal02, a done step under open goal p700 that misses its target)" },
    { at: at("2026-10-25T01:00:00Z"), case: "unasked result" },
  ], async hash => fixed[hash as keyof typeof fixed] ? at(fixed[hash as keyof typeof fixed]!) : undefined);
  assert.deepEqual(split.map(line => [line.side, line.fix]), [["before_fix", "62ca6828"], ["after_fix", "62ca6828"]]);
});

test("the 10-25 t15 take-back and t68 finding went out before e5d526be, and later ones read after it", async () => {
  // e5d526be refuses a text that names a todo the chat took back unanswered and a decision with no question, pick or todo in it.
  const fixed = { ...commits, "20cfb99d": "2026-10-22T18:31:47Z", c541b75c: "2026-10-23T08:31:26Z", e5d526be: "2026-10-25T22:00:00Z" };
  const split = await splitNoise([
    { at: at("2026-10-25T10:35:34Z"), case: "incident status (withdraws its own t15 ask after release 21 fixed the frozen panels)" },
    { at: at("2026-10-25T06:49:24Z"), case: "split answer (disk runway finding sent 16 s before the t68 ask that carries the same date in the next turn)" },
    { at: at("2026-10-26T01:00:00Z"), case: "incident status (withdraws its own t20 ask)" },
    { at: at("2026-10-26T01:00:00Z"), case: "split answer" },
  ], async hash => fixed[hash as keyof typeof fixed] ? at(fixed[hash as keyof typeof fixed]!) : undefined);
  assert.deepEqual(split.map(line => [line.side, line.fix]), [["before_fix", "e5d526be"], ["before_fix", "e5d526be"], ["after_fix", "e5d526be"], ["after_fix", "e5d526be"]]);
});

test("the 10-25 22:02Z t34 re-ask went out on a pre-c083958 build, and a later re-ask reads after the text fix", async () => {
  const fixed = { ...commits, c541b75c: "2026-10-23T08:31:26Z", "9b525da8": "2026-10-23T18:06:47Z", c083958b: "2026-10-25T22:09:25Z" };
  const split = await splitNoise([
    { at: at("2026-10-25T22:02:06Z"), case: "re-ask of an open For you todo (t34 nudge on a pre-c083958 build)" },
    { at: at("2026-10-26T01:00:00Z"), case: "re-ask of an open For you todo" },
  ], async hash => fixed[hash as keyof typeof fixed] ? at(fixed[hash as keyof typeof fixed]!) : undefined);
  assert.deepEqual(split.map(line => [line.side, line.fix]), [["before_fix", "c083958b"], ["after_fix", "c083958b"]]);
});

test("no noise line gives no lastEventAt", () => {
  assert.deepEqual(noiseLastEvent([]), {});
});

test("a kind with a later fix reads its leaks after the first fix as before the newest one", async () => {
  // 10-22: three same-incident asks went out after b084c910, and c541b75c refuses them; a line after c541b75c reads after its fix.
  const fixed = { ...commits, b084c910: "2026-10-21T09:40:55Z", c541b75c: "2026-10-23T08:31:26Z" };
  const split = await splitNoise([
    { at: at("2026-10-21T06:02:09Z"), case: "same incident asked again by another chat (prod crawler restart already asked on t56)" },
    { at: at("2026-10-22T13:22:18Z"), case: "same incident asked again by another chat (slot count already on metal-management t8)" },
    { at: at("2026-10-23T09:00:00Z"), case: "same incident asked again by another chat" },
  ], async hash => fixed[hash as keyof typeof fixed] ? at(fixed[hash as keyof typeof fixed]!) : undefined);
  assert.deepEqual(split.map(line => [line.side, line.fix]), [["before_fix", "c541b75c"], ["before_fix", "c541b75c"], ["after_fix", "c541b75c"]]);
});

test("the 10-25 lines that p1067 fixed or dropped read quiet a run after e5d526be, and only a new leak makes the miss live again", async () => {
  // d11 at 22:01Z on 10-25 read 72.2 (13 needed of 18) on five noise lines sent from 03:29Z to 10:57Z and labelled at 21:09:06Z. Two went
  // out before e5d526be; the t15 re-ask, the t34 nudge and the p161 done went out after the fixes of their kinds, and p1067 dropped a code
  // hold for them on replay evidence. Their after_fix side dated the count `now`, so every run read live and d9 at 22:13Z asked to replace
  // the fix, though no line had gone out after it.
  const fixed = { ...commits, "9b525da8": "2026-10-23T18:06:00Z", "20cfb99d": "2026-10-22T18:31:47Z", c541b75c: "2026-10-23T08:31:26Z",
    "841c86f8": "2026-10-24T05:16:23Z", "41665689": "2026-10-23T14:58:07Z", "62ca6828": "2026-10-24T22:46:37Z", e5d526be: "2026-10-25T21:36:14Z" };
  const time = async (hash: string) => fixed[hash as keyof typeof fixed] ? at(fixed[hash as keyof typeof fixed]!) : undefined;
  const labelled = at("2026-10-25T21:09:06Z");
  const lines = [
    { at: at("2026-10-25T03:51:20Z"), labelled, case: "re-ask of an open For you todo (t15 prod Vent update, first asked 10-24 17:07Z, resent with its cause at 03:51Z)" },
    { at: at("2026-10-25T10:35:34Z"), labelled, case: "incident status (withdraws its own t15 ask after release 21 fixed the frozen panels; closing t15 on the board says the same)" },
    { at: at("2026-10-25T10:57:42Z"), labelled, case: "same incident asked again by another chat (us-metal01 CI disk fill nudged on t34 at 10:57Z after Crawler VP asked t68 on the same disk at 06:49Z)" },
    { at: at("2026-10-25T03:29:10Z"), labelled, case: "unasked result (p161 one proxy session per walk, a done step under open goal p146, third line of a wake turn; the goal met its target so 62ca6828 did not fire)" },
    { at: at("2026-10-25T06:49:24Z"), labelled, case: "split answer (disk runway finding sent 16 s before the t68 ask that carries the same date in the next turn)" },
  ];
  const split = await splitNoise(lines, time);
  assert.deepEqual(noiseMetrics(split), { noise_before_fix_24h: 2, noise_after_fix_24h: 3, noise_no_fix_24h: 0 });
  assert.deepEqual(noiseLastEvent(split), { needed_pct_24h: at(fixed.e5d526be) });

  const run = (time: number, output: { metrics: Record<string, number>; lastEventAt: Record<string, number> }): DutyRunRecord =>
    ({ duty: "d11", at: time, trigger: "schedule", ms: 1, ...judge([metric], output) });
  const reading = { metrics: { needed_pct_24h: 72.2 }, lastEventAt: noiseLastEvent(split) };
  const live = [run(at("2026-10-25T22:01:44Z"), reading), run(at("2026-10-25T21:03:04Z"), reading)];
  assert.equal(metricStreaks(live)[0]!.quietSince, undefined);
  const aging = [run(at("2026-10-25T23:01:00Z"), reading), ...live];
  assert.equal(metricStreaks(aging)[0]!.quietSince, at(fixed.e5d526be));
  assert.equal(agingSince(aging), at(fixed.e5d526be));
  assert.match(missLine("d11", metricStreaks(aging)[0]!, metric.label, "%"), /Start no new job for it/);

  const window = 24 * 3_600_000;
  assert.deepEqual(noiseAging(split, 13, 90, window),
    { oldestLeaves: at("2026-10-26T03:29:10Z"), allowed: 1, meetsAt: at("2026-10-26T10:35:34Z"), pointsPerLine: 5.6 });
  assert.equal(noiseAging(split.slice(0, 1), 13, 90, window), undefined);

  const leak = await splitNoise([...lines, { at: at("2026-10-25T23:30:00Z"), labelled: at("2026-10-26T00:02:00Z"), case: "unasked result" }], time);
  const fresh = { metrics: { needed_pct_24h: 68.4 }, lastEventAt: noiseLastEvent(leak) };
  assert.equal(leak.at(-1)!.side, "after_fix");
  assert.equal(metricStreaks([run(at("2026-10-26T01:00:00Z"), fresh), run(at("2026-10-26T00:00:00Z"), reading), ...aging])[0]!.quietSince, undefined);
});
