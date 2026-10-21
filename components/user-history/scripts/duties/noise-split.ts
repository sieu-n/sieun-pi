import { repeatSide, type RepeatSide } from "./repeat-split.ts";

/**
 * The noise kinds a tell_owner check in src/chat-guard.ts refuses, by the `case` the Owner messages duty job labels a line with (LABELS), and the
 * commit that landed each check. A noise line is `before_fix` when it went out before its kind's fix landed, or when its case names a build
 * without that fix (`pre-<hash> build`), as mac-management's split answer at 23:11Z on 10-19 went out from the Mac 2 h after f4092cd landed.
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
];

export interface NoiseLine { at: number; case: string; side: RepeatSide; fix?: string; /** When `fix` landed, in ms. */ fixed?: number }

export async function splitNoise(lines: readonly { at: number; case: string }[], commitTime: (hash: string) => Promise<number | undefined>): Promise<NoiseLine[]> {
  return Promise.all(lines.map(async line => {
    const kind = line.case.toLowerCase();
    const row = NOISE_FIXES.find(entry => kind.startsWith(entry.kind.toLowerCase()));
    const fixed = row && await commitTime(row.fix);
    if (!row || fixed === undefined) return { ...line, side: "no_fix" as const };
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
 * `lastEventAt` for needed_pct_24h, read the way d10 reads its repeats (splitLastEvents): with only before_fix noise lines the share can only
 * rise as they leave the 24 h, so it dates from the newest fix landing and the miss line says to start no new job a run later. An after_fix or
 * no_fix line still needs a fix and dates it `now`. No noise line gives no `lastEventAt`.
 */
export function noiseLastEvent(split: readonly NoiseLine[], now: number): { needed_pct_24h?: number } {
  if (!split.length) return {};
  return { needed_pct_24h: split.some(line => line.side !== "before_fix") ? now : Math.max(...split.map(line => line.fixed!)) };
}

/** The line's lead in the flagged excerpt, such as "before fix f4092cd3 of 10-19 21:02Z". */
export function noiseSide(line: NoiseLine): string {
  if (line.side === "no_fix") return "no fix yet";
  return `${line.side === "after_fix" ? "after" : "before"} fix ${line.fix} of ${new Date(line.fixed!).toISOString().slice(5, 16).replace("T", " ")}Z`;
}
