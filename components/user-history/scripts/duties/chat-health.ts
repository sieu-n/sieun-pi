import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { BoardStore } from "../../src/chat-board-store.ts";
import { ACT_CLASSES, ARTICLE_LINK_WINDOW_MS, type ArticleLink, articleLinkMisses, ownerFacingTexts, type StepClass, wikiArticles } from "../../src/chat-checkin.ts";
import { CorrectionLedger, repeatsBetween } from "../../src/chat-corrections.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { CHECK_IN_PREFIX, foldReply, serverNote, type TurnStarter } from "../../src/shared/chat-feed.ts";
import { isPromptCustom, messageText } from "../../src/shared/turns.ts";
import type { ThreadMessage } from "../../src/shared/types.ts";
import { boardClasses, type ConvergenceMisses, daemonSessions, NO_MISSES } from "./board-classes.ts";
import { fixCommits, recheckSlices } from "./chat-health-recheck.ts";
import { unlinkedJobSentence } from "./job-mentions.ts";

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
/** An open-steps row of a check-in, with the step's class: `- p9 (stale-chase) "..." blocked, ..., last change 20 h ago`. */
const CLASS_ROW = /^- (p\d+) \(([a-z-]+)\) /;
/** The head of a check-in's open-steps list, and its fold line: a list without the fold names every open step. */
const OPEN_STEPS = "\n\nOpen steps, oldest change first:\n";
const OPEN_FOLD = /^- and \d+ more$/m;
/** A step the check-ins kept listing in a class the chat must act on (ACT_CLASSES) for this long is stalled: the chat was told and did not move it. */
const STALL_MS = 2 * HOUR;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'\u2019._/-]*/gu;
const BOARD_PREFIX = "[board] ";
const BOARD_ANSWER = " and answered: ";
const SKILL_BLOCK = /<skill\b[^>]*>[\s\S]*?<\/skill>/g;
const SIEUN_PI = /pi-pool|sieun-pi|user-history/i;
const WATCH_MS = 7 * WINDOW_MS;

type Metrics = { corrections: number; repeat_corrections: number; unlinked_job_mentions: number; article_link_not_in_todo: number; stalls_2h: number; dead_hours: number; unretried_errors: number; long_replies: number; off_brief: number; sieun_pi_breaks: number; recurred: number } & ConvergenceMisses;
type Kind = keyof Metrics | "recheck";
/** A problem the run saw, by a signature that stays the same when it happens again; the next runs watch for it. */
interface Seen { signature: string; slice: FlaggedSlice }
/** The duty's state between runs: each watched signature, when a run first flagged it, and the window end of the last run that did. */
type Watch = Record<string, { firstAt: number; lastRun: number }>;
interface Turn { starter: TurnStarter; at: number; lastText: string; lastTextAt: number }
interface Failure { at: number; reason: string }
interface Tally { metrics: Metrics; deadMs: number; ownerTurns: number; longTurns: number; flagged: Map<Kind, FlaggedSlice[]>; seen: Seen[];
  /** The `wiki:` articles each chat linked to the owner in the window, for `article_link_not_in_todo`. */
  links: Map<string, ArticleLink[]> }

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
  /** Since when the check-ins have listed each step in an act class without a break; a row in another class, or a full list without it, ends the run. */
  const acting = new Map<string, number>();
  /** Each step listed in an act class for STALL_MS or more, by its id, at its latest such row. */
  const stalls = new Map<string, { at: number; row: string }>();
  let turn: Turn | undefined;
  let settled = true;
  let failure: Failure | undefined;
  /** The latest token hook failure the pool queued a retry for. It is a break only if the turn ends on it; a later request that gets past the hook clears it. */
  let hookRetry: Failure | undefined;

  /**
   * `stalls_2h`: a step the check-ins listed in an act class (due, stale-chase, orphan) at every listing for STALL_MS or more. Its first such row
   * is the check-in telling the chat; a chat that sets a wait, a todo or an owner by the next tick moved the step, whatever its last change.
   */
  const countStalls = (text: string, at: number) => {
    const head = text.indexOf(OPEN_STEPS);
    if (head < 0) return;
    const listed = text.slice(head + OPEN_STEPS.length);
    const seenSteps = new Set<string>();
    for (const line of listed.split("\n")) {
      const row = line.trim();
      const open = CLASS_ROW.exec(row);
      if (!open) continue;
      const step = open[1]!;
      const cls = open[2] as StepClass;
      seenSteps.add(step);
      if (!ACT_CLASSES.has(cls)) { acting.delete(step); continue; }
      const since = acting.get(step) ?? at;
      acting.set(step, since);
      if (inWindow(at) && at - since >= STALL_MS) stalls.set(step, { at, row: `${cls} for ${Math.round((at - since) / HOUR)} h since the check-in told the chat: ${row}` });
    }
    if (!OPEN_FOLD.test(listed)) for (const step of acting.keys()) if (!seenSteps.has(step)) acting.delete(step);
  };
  const closeTurn = () => {
    if (!turn || !inWindow(turn.at)) return;
    if (turn.starter === "owner" && turn.lastText) {
      tally.ownerTurns++;
      // Long is what the page folds under "More": words outside code fences, a markdown link one word. A diagram or a link list the owner sees whole is not long.
      if (foldReply(turn.lastText).folded) { tally.longTurns++; flag("long_replies", turn.lastTextAt, `${words(turn.lastText)} words: ${turn.lastText}`); }
    }
  };
  const openTurn = (starter: TurnStarter, at: number) => { closeTurn(); turn = { starter, at, lastText: "", lastTextAt: at }; };
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
        if (text.startsWith(CHECK_IN_PREFIX)) countStalls(text, at);
        if (!inWindow(at)) continue;
        if (seen.has(text)) { tally.metrics.off_brief++; flag("off_brief", at, `repeated line: ${text}`, signature("repeat", text)); }
        seen.add(text);
        continue;
      }
      openTurn("owner", at);
      settled = false;
      const own = ownerWords(text);
      if (inWindow(at) && own && CORRECTION.test(own.replace(QUOTED, ""))) { tally.metrics.corrections++; flag("corrections", at, own); }
    } else if (message.role === "assistant") {
      failure = undefined;
      hookRetry = undefined;
      settled = message.stopReason !== "toolUse";
      const text = messageText(message).trim();
      if (turn && text) { turn.lastText = text; turn.lastTextAt = at; }
      const told = Array.isArray(message.content) ? message.content.flatMap(part => part.type === "toolCall" && part.name === "tell_owner" &&
        typeof part.arguments?.text === "string" ? [part.arguments.text] : []) : [];
      // What the owner reads: text on a turn the owner started, and tell_owner on any turn. Text on a wake-up is notes, shown folded.
      for (const said of inWindow(at) ? [...(turn?.starter === "owner" ? [text] : []), ...told] : []) {
        const sentence = unlinkedJobSentence(said);
        if (sentence) { tally.metrics.unlinked_job_mentions++; flag("unlinked_job_mentions", at, sentence); }
      }
      if (inWindow(at)) for (const said of ownerFacingTexts(message)) for (const link of wikiArticles(said)) tally.links.set(chat, [...tally.links.get(chat) ?? [], { at, link }]);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        failure = { at, reason: message.errorMessage?.trim() || `stopReason ${message.stopReason}` };
        if (SIEUN_PI.test(failure.reason.replace(POOL_RETRY_NOTE, ""))) {
          if (POOL_RETRY_NOTE.test(failure.reason)) hookRetry = failure;
          else if (inWindow(at)) breakSieunPi(failure);
        }
      }
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
  for (const [step, { at, row }] of stalls) { tally.metrics.stalls_2h++; flag("stalls_2h", at, row, `stalls_2h:${chat}:${step}`); }
  return true;
}

/**
 * `article_link_not_in_todo` (correction c5: an explanation the owner asked for is an owner todo until it is done, and the article's link goes in
 * the reply and in that todo): each open explanation todo of a chat's board, with each article the chat linked in the window that no todo names.
 */
async function countArticleLinks(boards: BoardStore, now: number, tally: Tally): Promise<void> {
  const flagged: FlaggedSlice[] = [];
  for (const [chat, links] of tally.links) {
    const board = await boards.read(chat).catch(() => null);
    for (const miss of articleLinkMisses(board?.todos ?? [], links, now - ARTICLE_LINK_WINDOW_MS)) {
      flagged.push({ chat, at: miss.at, kind: "article_link_not_in_todo", excerpt: clip(`${miss.todo.id} "${miss.todo.text}" lacks ${miss.link}, linked to the owner at ${new Date(miss.at).toISOString()}`) });
    }
  }
  tally.metrics.article_link_not_in_todo = flagged.length;
  tally.flagged.set("article_link_not_in_todo", flagged);
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

/** Yesterday's fixes to recheck, recurrences and corrections first, then one slice of each other kind in turn, newest first within a kind, up to MAX_FLAGGED. */
function pickFlagged(flagged: Map<Kind, FlaggedSlice[]>): FlaggedSlice[] {
  const newest = (kind: Kind, limit = Infinity) => [...(flagged.get(kind) ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
  const picked = [...newest("recheck"), ...newest("repeat_corrections"), ...newest("recurred"), ...newest("corrections")].slice(0, MAX_FLAGGED);
  const queues = [newest("sieun_pi_breaks", FEW), newest("unretried_errors"), newest("stalls_2h"), newest("long_replies"), newest("off_brief", 2 * FEW),
    newest("orphan_steps", FEW), newest("due_late", FEW), newest("stale_chase_24h", FEW), newest("job_end_unrecorded", FEW), newest("job_end_silent", FEW), newest("scope_misses", FEW),
    newest("article_link_not_in_todo", FEW), newest("unlinked_job_mentions", FEW)];
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
  const tally: Tally = { metrics: { corrections: 0, repeat_corrections: 0, unlinked_job_mentions: 0, article_link_not_in_todo: 0, stalls_2h: 0, dead_hours: 0, unretried_errors: 0, long_replies: 0, off_brief: 0, sieun_pi_breaks: 0, recurred: 0,
    ...NO_MISSES },
    deadMs: 0, ownerTurns: 0, longTurns: 0, flagged: new Map(), seen: [], links: new Map() };
  for (const id of ids) await measureChat(id, join(sessionsDir, `${id}.jsonl`), now - WINDOW_MS, now, tally);
  await countArticleLinks(new BoardStore(dataDir), now, tally);
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
