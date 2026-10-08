import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { CHECK_IN_PREFIX, serverNote, type TurnStarter } from "../../src/shared/chat-feed.ts";
import { isPromptCustom, messageText } from "../../src/shared/turns.ts";
import type { ThreadMessage } from "../../src/shared/types.ts";

const HOUR = 60 * 60_000;
const WINDOW_MS = 24 * HOUR;
const DEAD_AFTER_MS = 25 * 60_000;
const LONG_WORDS = 60;
const MAX_FLAGGED = 40;
const EXCERPT = 300;
const FEW = 5;
const CORRECTION = /\b(?:i told you|again|don['\u2019]?t|do not|stop|why did|why is|not what i|wrong|never|should have|you didn['\u2019]?t|still)\b/i;
const STALL = /with no board change and no owner activity for (\d+) (min|h|d)\b/;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'\u2019._/-]*/gu;
const BOARD_PREFIX = "[board] ";
const BOARD_ANSWER = " and answered: ";
const SKILL_BLOCK = /<skill\b[^>]*>[\s\S]*?<\/skill>/g;

type Metrics = { corrections: number; stalls_2h: number; dead_hours: number; unretried_errors: number; dup_system_lines: number; long_replies: number; wake_text: number };
type Kind = keyof Metrics;
interface Turn { starter: TurnStarter; wake: boolean; at: number; lastText: string; lastTextAt: number; wroteText: boolean }
interface Failure { at: number; reason: string }
interface Tally { metrics: Metrics; deadMs: number; ownerTurns: number; longTurns: number; flagged: Map<Kind, FlaggedSlice[]> }

const clip = (text: string): string => text.slice(0, EXCERPT);
const words = (text: string): number => text.match(WORD)?.length ?? 0;
const stallHours = (count: number, unit: string): number => unit === "d" ? count * 24 : unit === "h" ? count : count / 60;

/** The part of an owner message the owner wrote: a board answer after "and answered: ", none for a board choice, and no injected skill text. */
function ownerWords(text: string): string {
  if (text.startsWith(BOARD_PREFIX)) { const at = text.indexOf(BOARD_ANSWER); return at < 0 ? "" : text.slice(at + BOARD_ANSWER.length).trim(); }
  return text.replace(SKILL_BLOCK, "").trim();
}

function entryMessage(entry: unknown): ThreadMessage | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as { type?: unknown; message?: ThreadMessage; customType?: unknown; content?: unknown; timestamp?: unknown };
  const fallback = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  if (record.type === "message" && record.message && typeof record.message === "object") {
    return typeof record.message.timestamp === "number" ? record.message : { ...record.message, timestamp: fallback };
  }
  if (record.type === "custom_message" && typeof record.customType === "string" && (typeof record.content === "string" || Array.isArray(record.content))) {
    return { role: "custom", customType: record.customType, content: record.content as ThreadMessage & { role: "custom" } extends { content: infer C } ? C : never, timestamp: fallback };
  }
  return undefined;
}

async function measureChat(chat: string, file: string, start: number, now: number, tally: Tally): Promise<boolean> {
  let stream;
  try { stream = createReadStream(file, { encoding: "utf8" }); await new Promise<void>((resolve, reject) => { stream!.once("open", () => resolve()); stream!.once("error", reject); }); }
  catch { return false; }
  const inWindow = (at: number) => at >= start && at <= now;
  const flag = (kind: Kind, at: number, excerpt: string) => { const list = tally.flagged.get(kind) ?? []; list.push({ chat, at, kind, excerpt: clip(excerpt) }); tally.flagged.set(kind, list); };
  const seen = new Set<string>();
  let turn: Turn | undefined;
  let settled = true;
  let failure: Failure | undefined;

  const closeTurn = () => {
    if (!turn || !inWindow(turn.at)) return;
    if (turn.starter === "owner" && turn.lastText) {
      tally.ownerTurns++;
      const count = words(turn.lastText);
      if (count > LONG_WORDS) { tally.longTurns++; flag("long_replies", turn.lastTextAt, `${count} words: ${turn.lastText}`); }
    }
    if (turn.wake && turn.wroteText) { tally.metrics.wake_text++; flag("wake_text", turn.lastTextAt, turn.lastText); }
  };
  const openTurn = (starter: TurnStarter, wake: boolean, at: number) => { closeTurn(); turn = { starter, wake, at, lastText: "", lastTextAt: at, wroteText: false }; };
  const settleFailure = (nextAt: number | undefined) => {
    if (!failure) return;
    const end = nextAt ?? now;
    if (inWindow(failure.at) && end - failure.at > DEAD_AFTER_MS) {
      tally.metrics.unretried_errors++;
      tally.deadMs += end - failure.at;
      flag("unretried_errors", failure.at, `${((end - failure.at) / HOUR).toFixed(1)} h with no new message after: ${failure.reason}`);
    }
    failure = undefined;
  };

  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line) continue;
    let message: ThreadMessage | undefined;
    try { message = entryMessage(JSON.parse(line)); } catch { continue; }
    if (!message || !Number.isFinite(message.timestamp) || message.timestamp > now) continue;
    const at = message.timestamp;
    if (message.role === "user") {
      settleFailure(at);
      const text = messageText(message).trim();
      if (serverNote(text)) {
        if (settled) openTurn("agent", true, at);
        settled = false;
        if (!inWindow(at)) continue;
        if (seen.has(text)) { tally.metrics.dup_system_lines++; flag("dup_system_lines", at, text); }
        seen.add(text);
        if (text.startsWith(CHECK_IN_PREFIX)) {
          for (const row of text.split("\n")) {
            const stall = STALL.exec(row);
            if (stall && stallHours(Number(stall[1]), stall[2]!) >= 2) { tally.metrics.stalls_2h++; flag("stalls_2h", at, row.trim()); }
          }
        }
        continue;
      }
      openTurn("owner", false, at);
      settled = false;
      const own = ownerWords(text);
      if (inWindow(at) && own && CORRECTION.test(own)) { tally.metrics.corrections++; flag("corrections", at, own); }
    } else if (message.role === "assistant") {
      failure = undefined;
      settled = message.stopReason !== "toolUse";
      const text = messageText(message).trim();
      if (turn && text) { turn.lastText = text; turn.lastTextAt = at; turn.wroteText = true; }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        failure = { at, reason: message.errorMessage?.trim() || `stopReason ${message.stopReason}` };
      }
    } else if (message.role === "custom" && isPromptCustom(message)) {
      settleFailure(at);
      if (settled) openTurn("agent", message.customType === "agent_message", at);
      settled = false;
    }
  }
  closeTurn();
  settleFailure(undefined);
  return true;
}

/** Round one decimal. */
const tenth = (value: number): number => Math.round(value * 10) / 10;

/** Corrections first, then one slice of each other kind in turn, newest first within a kind, up to MAX_FLAGGED. */
function pickFlagged(flagged: Map<Kind, FlaggedSlice[]>): FlaggedSlice[] {
  const newest = (kind: Kind, limit = Infinity) => [...(flagged.get(kind) ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
  const picked = newest("corrections").slice(0, MAX_FLAGGED);
  const queues = [newest("unretried_errors"), newest("stalls_2h"), newest("long_replies"), newest("dup_system_lines", FEW), newest("wake_text", FEW)];
  while (picked.length < MAX_FLAGGED && queues.some(queue => queue.length)) {
    for (const queue of queues) { const next = queue.shift(); if (next && picked.length < MAX_FLAGGED) picked.push(next); }
  }
  return picked;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("chat-health: OUTPUT_FILE is not set\n"); process.exit(2); }
  const now = process.env.CHAT_HEALTH_NOW ? Number(process.env.CHAT_HEALTH_NOW) : Date.now();
  if (!Number.isFinite(now)) { process.stderr.write("chat-health: CHAT_HEALTH_NOW is not a number\n"); process.exit(2); }
  const dataDir = process.env.CHAT_HEALTH_DATA_DIR || join(homedir(), ".prime/agent/browser-chat");
  const sessionsDir = process.env.CHAT_HEALTH_SESSIONS_DIR || join(homedir(), ".prime/agent/sessions");
  const listed = JSON.parse(await readFile(join(dataDir, "chats.json"), "utf8")) as { ids?: unknown };
  const ids = Array.isArray(listed.ids) ? listed.ids.filter((id): id is string => typeof id === "string" && /^[\w-]+$/.test(id)) : [];
  const tally: Tally = { metrics: { corrections: 0, stalls_2h: 0, dead_hours: 0, unretried_errors: 0, dup_system_lines: 0, long_replies: 0, wake_text: 0 }, deadMs: 0, ownerTurns: 0, longTurns: 0, flagged: new Map() };
  for (const id of ids) await measureChat(id, join(sessionsDir, `${id}.jsonl`), now - WINDOW_MS, now, tally);
  tally.metrics.dead_hours = tenth(tally.deadMs / HOUR);
  tally.metrics.long_replies = tally.ownerTurns ? tenth(100 * tally.longTurns / tally.ownerTurns) : 0;
  const result: PrecheckOutput = { metrics: { ...tally.metrics }, flagged: pickFlagged(tally.flagged) };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

await main();
