import { repeatSide, type RepeatSide } from "./repeat-split.ts";

/**
 * The noise kinds a tell_owner check in src/chat-guard.ts refuses, or a text fix in the tell_owner description covers when no board signal
 * tells the kind from a needed line, by the `case` the Owner messages duty job labels a line with (LABELS), and the commit that landed each fix. A noise line is `before_fix` when it went out before its kind's fix landed, or when its case names a build
 * without that fix (`pre-<hash> build`), as mac-management's split answer at 23:11Z on 10-19 went out from the Mac 2 h after f4092cd landed.
 * A kind may have a row per fix, and the newest fix that landed decides the side, since a later check covers the leaks of an earlier one.
 * It is `after_fix` when the check was in place and the line still went out, and `no_fix` when no check covers its kind yet. A fix job for a
 * new kind adds its row here. On 10-21 06:03 KST d11's first run read needed_pct_24h 80.5% on 8 noise lines from 10-19 and 10-20.
 */
export const NOISE_FIXES: readonly { kind: string; fix: string }[] = [
  { kind: "split answer", fix: "f4092cd3" },
  { kind: "second report on a goal already reported", fix: "f45b220c" },
  { kind: "re-ask of an open For you todo", fix: "db253d1c" },
  { kind: "repeat of a decision already on For you", fix: "db253d1c" },
  { kind: "incident status sent as blocker", fix: "d7112574" },
  { kind: "same incident asked again by another chat", fix: "b084c910" },
  { kind: "progress relay", fix: "208a7bb5" },
  { kind: "progress on a goal still going", fix: "208a7bb5" },
  { kind: "ask for an ok no rule needs", fix: "20cfb99d" },
  { kind: "incident status (withdraws its own", fix: "20cfb99d" },
  { kind: "same incident asked again by another chat", fix: "c541b75c" },
  { kind: "re-ask of an open For you todo", fix: "c541b75c" },
  { kind: "incident status sent as blocker", fix: "c541b75c" },
  { kind: "split answer", fix: "c541b75c" },
  { kind: "progress relay", fix: "ff9ba241" },
  { kind: "progress on a goal still going", fix: "97e7663f" },
  { kind: "re-ask of an open For you todo", fix: "9b525da8" },
  { kind: "progress on a goal still going", fix: "02f07734" },
  { kind: "progress on a goal still going", fix: "673c7b17" },
  { kind: "same incident asked again by another chat", fix: "841c86f8" },
  // The tell_owner description text fix of 10-23, made when three replays (~/work/tell-owner-unasked-result/replay.md) found no check that spares done reports.
  { kind: "unasked result", fix: "41665689" },
  // The open goal done check, which refuses the p954 shape once and holds 11 needed lines for one call (~/work/tell-owner-open-goal-done/replay.md).
  { kind: "unasked result", fix: "62ca6828" },
  // The taken-back todo and empty decision checks of 10-25 (~/work/d11-after-fix-noise/replay.md).
  { kind: "incident status (withdraws its own", fix: "e5d526be" },
  { kind: "split answer", fix: "e5d526be" },
  // The re-ask refusal text fix of 10-25, which says a reminder of an open todo stays on For you (c81; a code hold cost 8 needed lines for 4 noise).
  { kind: "re-ask of an open For you todo", fix: "c083958b" },
  // The t34 nudge of 10-25 10:57:42Z went out as a resend after that same re-ask refusal, so c083958b's text covers it too.
  { kind: "same incident asked again by another chat", fix: "c083958b" },
  // The one-part-of-several check of 10-29, which refuses landing versions sent one at a time and a job's "Step 1 is done" (~/work/tell-owner-progress-trickle/replay.md).
  { kind: "progress on a goal still going", fix: "958ccd0a" },
];

/** A labelled noise line: `at` is when it went out, `labelled` when the duty run wrote its label (the LABELS row's `at`). */
export interface NoiseLine { at: number; labelled?: number; case: string; side: RepeatSide; fix?: string; /** When `fix` landed, in ms. */ fixed?: number }

export async function splitNoise(lines: readonly { at: number; labelled?: number; case: string }[], commitTime: (hash: string) => Promise<number | undefined>): Promise<NoiseLine[]> {
  return Promise.all(lines.map(async line => {
    const kind = line.case.toLowerCase();
    const landed = await Promise.all(NOISE_FIXES.filter(entry => kind.startsWith(entry.kind.toLowerCase())).map(async entry => ({ entry, at: await commitTime(entry.fix) })));
    const newest = landed.filter(fix => fix.at !== undefined).sort((a, b) => b.at! - a.at!)[0];
    if (!newest) return { ...line, side: "no_fix" as const };
    const { entry: row, at: fixed } = newest as { entry: typeof NOISE_FIXES[number]; at: number };
    const side = kind.includes(`pre-${row.fix.slice(0, 7)}`) ? "before_fix" : repeatSide(line.at, fixed);
    return { ...line, side, fix: row.fix, fixed };
  }));
}

/** The split as metrics, every side present: noise_before_fix_24h, noise_after_fix_24h and noise_no_fix_24h. */
export function noiseMetrics(split: readonly NoiseLine[]): Record<`noise_${RepeatSide}_24h`, number> {
  const count = (side: RepeatSide) => split.filter(line => line.side === side).length;
  return { noise_before_fix_24h: count("before_fix"), noise_after_fix_24h: count("after_fix"), noise_no_fix_24h: count("no_fix") };
}

/**
 * `lastEventAt` for needed_pct_24h: the newest change to a counted noise line, which is when it went out, when a run labelled it, or for a
 * before_fix line when its fix landed. A noise line pulls the share down for the whole 24 h whatever fix lands after it, so once a run has
 * passed since that change the miss reads quiet and only waits for the line to leave. An after_fix or no_fix line reads live on the run after
 * its label, whose miss line starts its fix, and a new leak reads live again, so d9 still judges a fix by the lines sent after it. Before
 * 10-26 an after_fix line dated the count `now`: the 10-25 t15 re-ask, t34 nudge and p161 done, sent from 03:29Z to 10:57Z and labelled at
 * 21:09Z, kept every run live after p1067 had fixed or dropped their kinds, and d9 asked at 22:13Z to replace a fix that no line had leaked
 * past. No noise line gives no `lastEventAt`.
 */
export function noiseLastEvent(split: readonly NoiseLine[]): { needed_pct_24h?: number } {
  if (!split.length) return {};
  return { needed_pct_24h: Math.max(...split.map(line => Math.max(line.at, line.labelled ?? 0, line.side === "before_fix" ? line.fixed! : 0))) };
}

/** When needed_pct_24h's noise leaves its window: the oldest line, how many noise lines `target` allows beside `needed` needed lines, and when the line that brings the count down to that leaves. */
export interface NoiseAging { oldestLeaves: number; allowed: number; meetsAt: number; pointsPerLine: number }

/**
 * The window's aging for a missed needed_pct_24h, if no new noise goes out and the needed count holds. On 10-25 22:01Z it read 13 needed of 18
 * lines: one line is 5.6 points, 90% allows 1 noise line beside 13 needed, and the 5 noise lines leave from 10-26 03:29Z to 10:57Z.
 */
export function noiseAging(split: readonly NoiseLine[], needed: number, target: number, windowMs: number): NoiseAging | undefined {
  const allowed = Math.floor(needed * (100 - target) / target + 1e-9);
  if (split.length <= allowed) return undefined;
  const leaves = split.map(line => line.at + windowMs).sort((a, b) => a - b);
  return { oldestLeaves: leaves[0]!, allowed, meetsAt: leaves[split.length - allowed - 1]!, pointsPerLine: Math.round(1000 / (needed + split.length)) / 10 };
}

/** The line's lead in the flagged excerpt, such as "before fix f4092cd3 of 10-19 21:02Z". */
export function noiseSide(line: NoiseLine): string {
  if (line.side === "no_fix") return "no fix yet";
  return `${line.side === "after_fix" ? "after" : "before"} fix ${line.fix} of ${new Date(line.fixed!).toISOString().slice(5, 16).replace("T", " ")}Z`;
}
