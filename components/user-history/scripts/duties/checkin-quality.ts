import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { localTime } from "../../src/chat-checkin.ts";
import { CHECK_IN_DUTY_ID, type DutyRunRecord, type FlaggedSlice } from "../../src/shared/chat-duties.ts";

/** A check-in finding still flagged after this many check-in runs in a row was seen and not fixed (owner, 10-12: remove the odd leftover steps). */
export const UNFIXED_RUNS = 4;

/**
 * `unfixed_flags`: each (kind, item) pair the chat's check-in flagged in UNFIXED_RUNS or more check-in runs in a row, with the streak ending in
 * the window. Runs are the check-in records of `<dataDir>/duties/<chatId>.runs.jsonl` that measured the board (a skipped or failed run neither
 * extends nor breaks a streak); a run that did not flag the pair ends its streak. One slice per pair, its longest streak in the window, with the
 * excerpt of the last run that flagged it. A missing runs file is no runs.
 */
export async function unfixedFlags(dataDir: string, chat: string, start: number, now: number): Promise<FlaggedSlice[]> {
  let text: string;
  try { text = await readFile(join(dataDir, "duties", `${chat}.runs.jsonl`), "utf8"); } catch { return []; }
  const runs: DutyRunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const run = JSON.parse(line) as DutyRunRecord;
      if (run.duty === CHECK_IN_DUTY_ID && run.verdict !== "skipped" && run.verdict !== "error" && Number.isFinite(run.at) && run.at <= now) runs.push(run);
    } catch { continue; }
  }
  runs.sort((a, b) => a.at - b.at);
  const streaks = new Map<string, { since: number; count: number }>();
  const worst = new Map<string, { since: number; count: number; last: FlaggedSlice; at: number }>();
  for (const run of runs) {
    const flagged = new Map<string, FlaggedSlice>();
    for (const slice of run.flagged ?? []) if (slice.item) flagged.set(`${slice.kind} ${slice.item}`, slice);
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
      if (run.duty === CHECK_IN_DUTY_ID && run.at >= start && run.at <= now && (run.metrics?.no_progress?.value ?? 0) > 0) hours.add(Math.floor(run.at / 3_600_000) * 3_600_000);
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
