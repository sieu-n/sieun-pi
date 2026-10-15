import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { activePause, type CheckInSetting, localTime } from "../../src/checkin-settings.ts";
import { CHECK_IN_DUTY_ID, type DutyRunRecord, type FlaggedSlice } from "../../src/shared/chat-duties.ts";
import { effectiveRun } from "../../src/shared/duty-streak.ts";

const HOUR = 60 * 60_000;

/** A check-in finding still flagged after this many check-in runs in a row was seen and not fixed (owner, 10-12: remove the odd leftover steps). */
export const UNFIXED_RUNS = 4;

/**
 * `unfixed_flags`: each (kind, item) pair the chat's check-in flagged in UNFIXED_RUNS or more check-in runs in a row, with the streak ending in
 * the window. Runs are the check-in records of `<dataDir>/duties/<chatId>.runs.jsonl` that measured the board (a skipped or failed run neither
 * extends nor breaks a streak), each with the flags its own job left (`liveFlags`); a run that did not flag the pair ends its streak. One slice per pair, its longest streak in the window, with the
 * excerpt of the last run that flagged it. A missing runs file is no runs.
 */
export async function unfixedFlags(dataDir: string, chat: string, start: number, now: number): Promise<FlaggedSlice[]> {
  const runs = await checkInRuns(dataDir, chat, now);
  const streaks = new Map<string, { since: number; count: number }>();
  const worst = new Map<string, { since: number; count: number; last: FlaggedSlice; at: number }>();
  for (const run of runs) {
    const flagged = new Map<string, FlaggedSlice>();
    for (const slice of liveFlags(run)) if (slice.item) flagged.set(`${slice.kind} ${slice.item}`, slice);
    for (const key of streaks.keys()) if (!flagged.has(key)) streaks.delete(key);
    for (const [key, slice] of flagged) {
      const streak = streaks.get(key) ?? { since: run.at, count: 0 };
      streak.count++;
      streaks.set(key, streak);
      const best = worst.get(key);
      if (run.at >= start && streak.count >= UNFIXED_RUNS && (!best || streak.count >= best.count)) worst.set(key, { ...streak, last: slice, at: run.at });
    }
  }
  return [...worst.entries()].sort(([, a], [, b]) => b.count - a.count).map(([key, { since, count, last, at }]) => ({ chat, at, kind: "unfixed_flags", ...(last.item ? { item: last.item } : {}),
    excerpt: `${key} flagged in ${count} check-ins in a row since ${localTime(since)}: ${last.excerpt}` }));
}

/**
 * A check-in's slack past two intervals before the Chat system calls it not running. Measured 10-13 to 10-15 over 8 chats: the gap between
 * measured check-in runs is one interval at p50 and two at p90 (a run skips while the last check-in job still works), 30 min on a 15 min chat.
 */
export const CHECK_IN_LATE_MS = 15 * 60_000;
/** Where a chat's check-in stands for its stuck steps: paused by the owner, not running for over two intervals, or running. */
export type CheckInStand = "owner_paused" | "not_running" | "running";
/** A stuck step a check-in already had a turn on: flagged stuck in every measured check-in run since `since`, `runs` of them. */
export interface StuckLeft { item: string; since: number; runs: number }

/** The chat's measured check-in runs up to `now`, oldest first: a skipped or failed run did not look at the board. A missing file is none. */
async function checkInRuns(dataDir: string, chat: string, now: number): Promise<DutyRunRecord[]> {
  let text = "";
  try { text = await readFile(join(dataDir, "duties", `${chat}.runs.jsonl`), "utf8"); } catch { return []; }
  const runs: DutyRunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const run = JSON.parse(line) as DutyRunRecord;
      if (run.duty === CHECK_IN_DUTY_ID && measured(run) && Number.isFinite(run.at) && run.at <= now) runs.push(run);
    } catch { continue; }
  }
  return runs.sort((a, b) => a.at - b.at);
}
/** A run that looked at the board, judged as `effectiveRun` reads it: a skipped run, or one whose after-job measure failed, does not count. */
const measured = (run: DutyRunRecord): boolean => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; };
/**
 * The run's flagged items still standing after its own job (`effectiveRun`): a kind whose metric the after-job measure found on target was fixed
 * by that job, so its items drop. The after-job measure holds counts, not items, so a kind still missed keeps every item the run flagged.
 * Chat 01a1164b 10-15: a check-in flagged loose_goals and its job gave p447 a step in the same turn (chat-duty-run.ts, `after`).
 */
export function liveFlags(run: DutyRunRecord): FlaggedSlice[] {
  if (!run.after) return run.flagged ?? [];
  const metrics = effectiveRun(run).metrics;
  return (run.flagged ?? []).filter(slice => metrics[slice.kind]?.met !== true);
}
const stuckItems = (run: DutyRunRecord): string[] => liveFlags(run).flatMap(slice => slice.kind === "stuck_steps" && slice.item ? [slice.item] : []);
const ownerPaused = (setting: CheckInSetting, now: number): boolean => activePause(setting, now) !== null && setting.pausedBy === "owner";

/**
 * Left stuck by a check-in (owner 10-14 c64: every open step is moved by a live owner, in For you or parked, judged on stuck steps and stuck
 * step-hours; 10-15 c75: the duty pushes until green). A step counts from the second measured check-in run in a row that flags it as
 * `stuck_steps`: the first run's job had its turn and ended (a run skips while it works), and the step is still stuck. A step that went stuck
 * since the last check-in is the next check-in's work: on 10-15 the owner answered t28 at 08:40Z, and at 08:50Z the 14 steps of launch main bro
 * that waited on it read as stuck, 6 min before its next check-in.
 *
 * `stuckPastCheckIn` is the board now: each stuck step (`stuck`, from the board classes) that the latest measured runs flagged twice or more in a
 * row. When the check-in has not measured the board for two intervals plus CHECK_IN_LATE_MS, nobody pushes, so every stuck step counts. When the
 * owner paused the check-in (the Check-in card's pause), the chat's steps are his to hold and count nowhere; a pause by an agent or the server does.
 */
export async function stuckPastCheckIn(dataDir: string, chat: string, stuck: readonly string[], setting: CheckInSetting, now: number):
  Promise<{ stand: CheckInStand; lastAt?: number; left: StuckLeft[] }> {
  if (ownerPaused(setting, now)) return { stand: "owner_paused", left: [] };
  const runs = await checkInRuns(dataDir, chat, now);
  const lastAt = runs.at(-1)?.at;
  if (lastAt === undefined || now - lastAt > 2 * setting.everyMs + CHECK_IN_LATE_MS) {
    return { stand: "not_running", ...(lastAt !== undefined ? { lastAt } : {}), left: stuck.map(item => ({ item, since: lastAt ?? now, runs: 0 })) };
  }
  const left: StuckLeft[] = [];
  for (const item of stuck) {
    let since = now;
    let count = 0;
    for (let index = runs.length - 1; index >= 0 && stuckItems(runs[index]!).includes(item); index--) { since = runs[index]!.at; count++; }
    if (count >= 2) left.push({ item, since, runs: count });
  }
  return { stand: "running", lastAt, left };
}

/** One step's time left stuck by a check-in in the window: hours, when it first counted, and the last run's line for it. */
export interface StuckHours { item: string; hours: number; since: number; excerpt: string }
/**
 * The chat's step-hours in [start, now] from its measured check-in runs: each run holds from its time to the next run (or `now`), with its open
 * steps (the sum of its `classes`) and the steps left stuck by a check-in (`stuckPastCheckIn`'s rule: flagged in this run and the one before).
 * An owner-paused chat has no step-hours, like a chat with no runs.
 */
export async function stuckStepHours(dataDir: string, chat: string, setting: CheckInSetting, start: number, now: number):
  Promise<{ openHours: number; stuckHours: number; steps: StuckHours[] }> {
  const empty = { openHours: 0, stuckHours: 0, steps: [] };
  if (ownerPaused(setting, now)) return empty;
  const runs = await checkInRuns(dataDir, chat, now);
  const steps = new Map<string, StuckHours>();
  let openHours = 0;
  let stuckHours = 0;
  let before = new Set<string>();
  runs.forEach((run, index) => {
    const flagged = stuckItems(run);
    const from = Math.max(run.at, start);
    const to = Math.min(runs[index + 1]?.at ?? now, now);
    if (to > from) {
      const hours = (to - from) / HOUR;
      openHours += hours * Object.values(run.classes ?? {}).reduce((sum, count) => sum + (Number(count) || 0), 0);
      for (const item of flagged.filter(item => before.has(item))) {
        stuckHours += hours;
        const excerpt = run.flagged?.find(slice => slice.kind === "stuck_steps" && slice.item === item)?.excerpt ?? item;
        const seen = steps.get(item);
        steps.set(item, { item, hours: (seen?.hours ?? 0) + hours, since: seen?.since ?? from, excerpt });
      }
    }
    before = new Set(flagged);
  });
  return { openHours, stuckHours, steps: [...steps.values()].sort((a, b) => b.hours - a.hours) };
}

/**
 * `no_progress_hours`: the hours of the window in which a check-in run of the chat measured `no_progress` (owner 10-12: "work should be
 * moving"). A missing runs file is none. Returns the hour starts, oldest first.
 */
export async function noProgressHours(dataDir: string, chat: string, start: number, now: number): Promise<number[]> {
  let text: string;
  try { text = await readFile(join(dataDir, "duties", `${chat}.runs.jsonl`), "utf8"); } catch { return []; }
  const hours = new Set<number>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const run = JSON.parse(line) as DutyRunRecord;
      if (run.duty === CHECK_IN_DUTY_ID && run.at >= start && run.at <= now && (effectiveRun(run).metrics?.no_progress?.value ?? 0) > 0) hours.add(Math.floor(run.at / 3_600_000) * 3_600_000);
    } catch { continue; }
  }
  return [...hours].sort((a, b) => a - b);
}

const PLAN = String.raw`(?:plan|board|steps|goals|hierarchy)`;
const NOT_UI = String.raw`(?!\s*(?:panel|ui|layout|page|view|component|card|css|style|tab|feature|code)\b)`;
/** The owner asking a chat to tidy its plan or board, or to delete or close plan items, in English or Korean; not a product ask about a plan or the board UI. */
const BOARD_ASK = [
  new RegExp(String.raw`\b(?:organi[sz]e|reorgani[sz]e|clean(?:\s+up)?|tidy(?:\s+up)?|sync|fix|sort\s+out|restructure|prune)\s+(?:up\s+)?(?:the\s+|your\s+|this\s+|its\s+|our\s+)?${PLAN}\b${NOT_UI}`, "i"),
  new RegExp(String.raw`\b${PLAN}\s+(?:clean[\s-]?up|is\s+(?:a\s+)?mess(?:y)?)\b`, "i"),
  /\b(?:delete|remove|close|drop)\s+(?:(?:the\s+)?(?:steps?|goals?|items?)\s+)?p\d+\b/i,
  /\b(?:delete|remove|close|drop)\s+(?:the\s+|those\s+|these\s+|all\s+)?(?:stale|weird|old|done|shipped|finished|orphan|duplicate|dead)\s+(?:plan\s+)?(?:steps|goals|items)\b/i,
  /\b(?:delete|remove|close|drop)\s+[^.\n?!]{0,30}?\b(?:from|on|in)\s+(?:the\s+|your\s+)?(?:plan|board)\b/i,
  /(?:plan|board|플랜|보드|계획|hierarchy|하이어라키|스텝|step|goal|골)[^.\n?!]{0,20}?정리/i,
  /정리[^.\n?!]{0,10}?(?:plan|board|플랜|보드|계획)/i,
  /\bp\d+[^.\n?!]{0,15}?(?:지우|지워|삭제|닫|없애|정리)/i,
];
export const ownerBoardAsk = (words: string): boolean => BOARD_ASK.some(pattern => pattern.test(words));
