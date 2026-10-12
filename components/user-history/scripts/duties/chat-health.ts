import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { BoardStore } from "../../src/chat-board-store.ts";
import { type ConvergenceMisses, localTime, NO_MISSES } from "../../src/chat-checkin.ts";
import { CorrectionLedger, repeatsBetween } from "../../src/chat-corrections.ts";
import { placeholderTodo } from "../../src/shared/chat-board.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { foldReply, serverNote, TELL_OWNER_TOOL, type TurnStarter } from "../../src/shared/chat-feed.ts";
import { findingsLine, lintOwnerReply } from "../../src/shared/reply-lint.ts";
import { isPromptCustom, messageText } from "../../src/shared/turns.ts";
import type { ThreadMessage } from "../../src/shared/types.ts";
import { boardClasses, daemonSessions } from "./board-classes.ts";
import { fixCommits, recheckSlices } from "./chat-health-recheck.ts";
import { noProgressHours, ownerBoardAsk, unfixedFlags } from "./checkin-quality.ts";
import { unlinkedJobSentence } from "../../src/shared/job-mentions.ts";

const HOUR = 60 * 60_000;
const WINDOW_MS = 24 * HOUR;
const DEAD_AFTER_MS = 25 * 60_000;
const MAX_FLAGGED = 40;
const EXCERPT = 300;
const FEW = 5;
/** Phrases where the owner corrects how the chat works; a bare "never", "still" or "don't" is usually a product direction or a status question. */
const CORRECTION = /\b(?:i told you|i (?:already )?(?:said|asked)|didn['\u2019]?t i (?:say|ask|request|tell)|not what i|you didn['\u2019]?t|you did not|you (?:were|are) wrong|(?:that|this|it) (?:is|was) wrong|why did you|why (?:is|are) (?:nothing|you)|stop (?:doing|saying|writing|asking)|never (?:says?|does|do|writes?|uses?|asks?)|don['\u2019]?t (?:do|say|write|use|ask|force)|(?:dont|don['\u2019]?t|do not) (?:get it|understand)|explain (?:it |this )?(?:more|again)|are you sure|what the fuck|wtf|you should have|(?:it|this) doesn['\u2019]?t happen again|always (?:message|reply|write|answer|talk|speak))\b|^again\b/i;
/** Quoted text is someone else's words, such as an agent quoting the owner's earlier question. */
const QUOTED = /[\u201c"][^\u201d"]*[\u201d"]/g;
/** The note the pool's extension appends to an error it retries: on a provider error the provider failed, not sieun-pi; on a token hook failure it is a break only if the retry also fails. */
const POOL_RETRY_NOTE = / pi-pool: [\s\S]*; the retry uses [\s\S]*$/;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'\u2019._/-]*/gu;
const BOARD_PREFIX = "[board] ";
const BOARD_ANSWER = " and answered: ";
const SKILL_BLOCK = /<skill\b[^>]*>[\s\S]*?<\/skill>/g;
const SIEUN_PI = /pi-pool|sieun-pi|user-history/i;
const WATCH_MS = 7 * WINDOW_MS;

type Metrics = { corrections: number; repeat_corrections: number; unlinked_job_mentions: number; placeholder_todos: number; dead_hours: number; unretried_errors: number; long_replies: number; slop_replies: number; off_brief: number; sieun_pi_breaks: number; recurred: number; unfixed_flags: number; owner_board_asks: number; no_progress_hours: number } & ConvergenceMisses;
type Kind = keyof Metrics | "recheck";
/** A problem the run saw, by a signature that stays the same when it happens again; the next runs watch for it. */
interface Seen { signature: string; slice: FlaggedSlice }
/** The duty's state between runs: each watched signature, when a run first flagged it, and the window end of the last run that did. */
type Watch = Record<string, { firstAt: number; lastRun: number }>;
/** A reply the owner reads as a bubble, with the tell_owner call id when it is one. */
interface Said { text: string; at: number; id?: string }
/**
 * `told` holds the turn's tell_owner calls the tool did not refuse and `texts` the chat's own text messages. The page shows the told text as
 * the reply and folds the turn's own text into updates when the turn has a told call (`chatLines`), so the metrics read the same.
 */
interface Turn { starter: TurnStarter; at: number; lastText: string; lastTextAt: number; told: Said[]; texts: Said[] }
interface Failure { at: number; reason: string }
interface Tally { metrics: Metrics; deadMs: number; ownerTurns: number; longTurns: number; flagged: Map<Kind, FlaggedSlice[]>; seen: Seen[] }

const clip = (text: string): string => text.slice(0, EXCERPT);
const words = (text: string): number => text.match(WORD)?.length ?? 0;
const signature = (kind: string, text: string): string => `${kind}:${text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 160)}`;

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
  const flag = (kind: Kind, at: number, excerpt: string, watch?: string) => {
    const slice = { chat, at, kind, excerpt: clip(excerpt) };
    const list = tally.flagged.get(kind) ?? []; list.push(slice); tally.flagged.set(kind, list);
    if (watch) tally.seen.push({ signature: watch, slice });
  };
  const seen = new Set<string>();
  let turn: Turn | undefined;
  let settled = true;
  let failure: Failure | undefined;
  /** The latest token hook failure the pool queued a retry for. It is a break only if the turn ends on it; a later request that gets past the hook clears it. */
  let hookRetry: Failure | undefined;

  const closeTurn = () => {
    if (!turn) return;
    // What the owner reads: the told text when the turn has a told call, else the chat's text on a turn the owner started. Text on a wake-up is notes.
    const read = turn.told.length ? turn.told : turn.starter === "owner" ? turn.texts : [];
    for (const said of read.filter(said => inWindow(said.at))) {
      const sentence = unlinkedJobSentence(said.text);
      if (sentence) { tally.metrics.unlinked_job_mentions++; flag("unlinked_job_mentions", said.at, sentence); }
    }
    if (turn.starter !== "owner" || !inWindow(turn.at)) return;
    const replies = turn.told.length ? turn.told : turn.lastText ? [{ text: turn.lastText, at: turn.lastTextAt }] : [];
    if (!replies.length) return;
    tally.ownerTurns++;
    // Long is what the page folds under "More": words outside code fences, a markdown link one word. A diagram or a link list the owner sees whole is not long.
    const long = replies.find(said => foldReply(said.text).folded);
    if (long) { tally.longTurns++; flag("long_replies", long.at, `${words(long.text)} words: ${long.text}`); }
    // slop_replies: the reply lint's findings other than length (src/shared/reply-lint.ts), with the owner's words of that turn spared.
    for (const said of replies) {
      const slop = lintOwnerReply(said.text, ownerSaid).filter(finding => finding.kind !== "long");
      if (slop.length) { tally.metrics.slop_replies++; flag("slop_replies", said.at, `${findingsLine(slop)}: ${said.text}`); break; }
    }
  };
  /** The owner's words in the message that started the latest owner turn: a word the owner used is not jargon in the reply. */
  let ownerSaid = "";
  const openTurn = (starter: TurnStarter, at: number) => { closeTurn(); turn = { starter, at, lastText: "", lastTextAt: at, told: [], texts: [] }; };
  const settleFailure = (nextAt: number | undefined) => {
    if (!failure) return;
    const end = nextAt ?? now;
    if (inWindow(failure.at) && end - failure.at > DEAD_AFTER_MS) {
      tally.metrics.unretried_errors++;
      tally.deadMs += end - failure.at;
      flag("unretried_errors", failure.at, `${((end - failure.at) / HOUR).toFixed(1)} h with no new message after: ${failure.reason}`, signature("error", failure.reason));
    }
    failure = undefined;
  };
  const breakSieunPi = (broken: Failure) => { tally.metrics.sieun_pi_breaks++; flag("sieun_pi_breaks", broken.at, broken.reason, signature("error", broken.reason)); };
  const settleHookRetry = () => {
    if (hookRetry && inWindow(hookRetry.at)) breakSieunPi(hookRetry);
    hookRetry = undefined;
  };

  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line) continue;
    let message: ThreadMessage | undefined;
    try { message = entryMessage(JSON.parse(line)); } catch { continue; }
    if (!message || !Number.isFinite(message.timestamp) || message.timestamp > now) continue;
    const at = message.timestamp;
    if (message.role === "user") {
      settleFailure(at);
      settleHookRetry();
      const text = messageText(message).trim();
      if (serverNote(text)) {
        if (settled) openTurn("agent", at);
        settled = false;
        if (!inWindow(at)) continue;
        if (seen.has(text)) { tally.metrics.off_brief++; flag("off_brief", at, `repeated line: ${text}`, signature("repeat", text)); }
        seen.add(text);
        continue;
      }
      openTurn("owner", at);
      settled = false;
      const own = ownerWords(text);
      ownerSaid = own;
      if (inWindow(at) && own && CORRECTION.test(own.replace(QUOTED, ""))) { tally.metrics.corrections++; flag("corrections", at, own); }
      // owner_board_asks: the owner had to ask the chat to tidy its plan, which the check-in should keep tidy (owner 10-12: remove the odd leftover steps and tidy the plan hierarchy).
      if (inWindow(at) && own && ownerBoardAsk(own.replace(QUOTED, ""))) { tally.metrics.owner_board_asks++; flag("owner_board_asks", at, own); }
    } else if (message.role === "assistant") {
      failure = undefined;
      hookRetry = undefined;
      settled = message.stopReason !== "toolUse";
      const text = messageText(message).trim();
      if (turn && text) { turn.lastText = text; turn.lastTextAt = at; turn.texts.push({ text, at }); }
      if (turn && Array.isArray(message.content)) for (const part of message.content) {
        if (part.type === "toolCall" && part.name === TELL_OWNER_TOOL && typeof part.arguments?.text === "string" && part.arguments.text.trim()) {
          turn.told.push({ text: part.arguments.text.trim(), at, id: part.id });
        }
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        failure = { at, reason: message.errorMessage?.trim() || `stopReason ${message.stopReason}` };
        if (SIEUN_PI.test(failure.reason.replace(POOL_RETRY_NOTE, ""))) {
          if (POOL_RETRY_NOTE.test(failure.reason)) hookRetry = failure;
          else if (inWindow(at)) breakSieunPi(failure);
        }
      }
    } else if (message.role === "toolResult") {
      // A refused tell_owner never reached the owner (the feed shows nothing for it).
      if (message.isError && turn) turn.told = turn.told.filter(said => said.id !== message.toolCallId);
    } else if (message.role === "custom" && isPromptCustom(message)) {
      settleFailure(at);
      settleHookRetry();
      if (settled) openTurn("agent", at);
      settled = false;
    }
  }
  closeTurn();
  settleFailure(undefined);
  settleHookRetry();
  return true;
}

/**
 * `placeholder_todos` (correction c14, owner 10-09: "what the fuck is  this???"): each open agent todo with no choices that only holds a place
 * for something not ready (`placeholderTodo`, the check `chat_board` refuses new ones with). For you holds only what the owner must decide or do now.
 */
async function countPlaceholderTodos(boards: BoardStore, chats: readonly string[], now: number, tally: Tally): Promise<void> {
  const flagged: FlaggedSlice[] = [];
  for (const chat of chats) {
    const board = await boards.read(chat).catch(() => null);
    for (const todo of board?.todos ?? []) {
      if (todo.done || todo.from !== "agent" || !placeholderTodo(todo)) continue;
      const at = Date.parse(todo.at);
      flagged.push({ chat, at: Number.isFinite(at) ? at : now, kind: "placeholder_todos",
        excerpt: clip(`${todo.id} "${todo.text}" is a placeholder in For you: make it a plan step and send the link in a chat message when it exists`) });
    }
  }
  tally.metrics.placeholder_todos = flagged.length;
  tally.flagged.set("placeholder_todos", flagged);
}

/** Round one decimal. */
const tenth = (value: number): number => Math.round(value * 10) / 10;

/**
 * The watch list: a problem a run flagged stays on it for WATCH_MS, and each later run counts it again in `recurred` when it happens after that run.
 * One count per signature, so a bug that came back is one, however often it fired. Returns the watch list for the next run.
 */
function watchRecurrences(seen: readonly Seen[], watch: Watch, now: number, tally: Tally): Watch {
  const recurred = new Map<string, FlaggedSlice>();
  for (const { signature: key, slice } of seen) {
    const entry = watch[key];
    if (entry && (slice.at ?? 0) > entry.lastRun && !recurred.has(key)) {
      recurred.set(key, { ...slice, kind: "recurred", excerpt: clip(`${slice.kind}, first flagged ${new Date(entry.firstAt).toISOString().slice(0, 10)}: ${slice.excerpt}`) });
    }
  }
  tally.metrics.recurred = recurred.size;
  tally.flagged.set("recurred", [...recurred.values()]);
  const next: Watch = Object.fromEntries(Object.entries(watch).filter(([, entry]) => now - entry.lastRun < WATCH_MS));
  for (const { signature: key } of seen) next[key] = { firstAt: next[key]?.firstAt ?? now, lastRun: now };
  return next;
}

async function readWatch(file: string | undefined): Promise<Watch> {
  if (!file) return {};
  try { const state = JSON.parse(await readFile(file, "utf8")) as { watch?: unknown }; return typeof state.watch === "object" && state.watch !== null ? state.watch as Watch : {}; }
  catch { return {}; }
}

/** Yesterday's fixes to recheck, recurrences, merges without the owner's go, check-in findings left unfixed (the longest streaks, up to FEW), corrections, owner board asks and chats with goals and no duty first, then one slice of each other kind in turn, newest first within a kind, up to MAX_FLAGGED. */
function pickFlagged(flagged: Map<Kind, FlaggedSlice[]>): FlaggedSlice[] {
  const newest = (kind: Kind, limit = Infinity) => [...(flagged.get(kind) ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
  // goals_without_duty, target 0 in chat-health.duty.json: the duty proposals review of 10-12 found 5 chats with open goals and no duty.
  const picked = [...newest("recheck"), ...newest("repeat_corrections"), ...newest("recurred"), ...newest("merges_without_go"), ...newest("unfixed_flags", FEW), ...newest("no_progress_hours", FEW), ...newest("corrections"),
    ...newest("owner_board_asks"), ...newest("goals_without_duty")].slice(0, MAX_FLAGGED);
  const queues = [newest("sieun_pi_breaks", FEW), newest("unretried_errors"), newest("long_replies"), newest("slop_replies", FEW), newest("off_brief", 2 * FEW),
    newest("orphan_steps", FEW), newest("due_late", FEW), newest("stale_chase_24h", FEW), newest("job_end_unrecorded", FEW), newest("job_end_silent", FEW), newest("scope_misses", FEW), newest("idle_goals", FEW), newest("goal_gaps", FEW), newest("blocked_on_others", FEW),
    newest("finished_open", FEW), newest("loose_goals", FEW), newest("extra_goals", FEW), newest("open_under_closed", FEW), newest("held_elsewhere", FEW), newest("wait_met", FEW), newest("stale_steps", FEW), newest("goals_to_fold", FEW), newest("one_session_load", FEW), newest("redundant_heartbeats", FEW),
    newest("placeholder_todos", FEW), newest("unlinked_job_mentions", FEW)];
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
  const tally: Tally = { metrics: { corrections: 0, repeat_corrections: 0, unlinked_job_mentions: 0, placeholder_todos: 0, dead_hours: 0, unretried_errors: 0, long_replies: 0, slop_replies: 0, off_brief: 0, sieun_pi_breaks: 0, recurred: 0, unfixed_flags: 0, owner_board_asks: 0,
    no_progress_hours: 0, ...NO_MISSES },
    deadMs: 0, ownerTurns: 0, longTurns: 0, flagged: new Map(), seen: [] };
  for (const id of ids) await measureChat(id, join(sessionsDir, `${id}.jsonl`), now - WINDOW_MS, now, tally);
  await countPlaceholderTodos(new BoardStore(dataDir), ids, now, tally);
  const unfixed = (await Promise.all(ids.map(id => unfixedFlags(dataDir, id, now - WINDOW_MS, now)))).flat();
  tally.metrics.unfixed_flags = unfixed.length;
  tally.flagged.set("unfixed_flags", unfixed);
  const stuck = await Promise.all(ids.map(async id => ({ id, hours: await noProgressHours(dataDir, id, now - WINDOW_MS, now) })));
  tally.metrics.no_progress_hours = stuck.reduce((sum, chat) => sum + chat.hours.length, 0);
  tally.flagged.set("no_progress_hours", stuck.filter(chat => chat.hours.length).map(chat => ({ chat: chat.id, at: chat.hours.at(-1)!, kind: "no_progress_hours",
    excerpt: `${chat.hours.length} hours with no plan item done while open steps were not blocked, last at ${localTime(chat.hours.at(-1)!)}` })));
  tally.metrics.dead_hours = tenth(tally.deadMs / HOUR);
  const repeats = repeatsBetween(await new CorrectionLedger(dataDir).read(), now - WINDOW_MS, now);
  tally.metrics.repeat_corrections = repeats.length;
  tally.flagged.set("repeat_corrections", repeats.map(({ entry, repeat }) => ({ chat: repeat.chat.id, at: Date.parse(repeat.at), kind: "repeat_corrections",
    excerpt: clip(`${entry.id} "${entry.rule}" repeated in ${repeat.chat.name || repeat.chat.id} (first ${entry.at.slice(0, 10)} in ${entry.chat.name || entry.chat.id}): ${repeat.words}`) })));
  for (const chat of await boardClasses({ dataDir, now, sessions: daemonSessions, chats: ids })) {
    for (const [key, value] of Object.entries(chat.misses) as [keyof ConvergenceMisses, number][]) tally.metrics[key] += value;
    for (const slice of chat.flagged) { const list = tally.flagged.get(slice.kind as Kind) ?? []; list.push(slice); tally.flagged.set(slice.kind as Kind, list); }
  }
  tally.metrics.long_replies = tally.ownerTurns ? tenth(100 * tally.longTurns / tally.ownerTurns) : 0;
  const watch = watchRecurrences(tally.seen, await readWatch(process.env.STATE_FILE), now, tally);
  const fixes = fixCommits(process.env.CHAT_HEALTH_GIT_DIR || join(import.meta.dirname, "..", ".."), now - 2 * WINDOW_MS, now - WINDOW_MS);
  tally.flagged.set("recheck", recheckSlices(fixes, { ...tally.metrics }).map(slice => ({ ...slice, excerpt: clip(slice.excerpt) })));
  const result: PrecheckOutput = { metrics: { ...tally.metrics }, flagged: pickFlagged(tally.flagged) };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  if (process.env.STATE_FILE) await writeFile(process.env.STATE_FILE, JSON.stringify({ watch }) + "\n");
}

await main();
