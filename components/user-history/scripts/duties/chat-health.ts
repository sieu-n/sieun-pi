import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { BoardStore } from "../../src/chat-board-store.ts";
import { type ConvergenceMisses, NO_MISSES } from "../../src/chat-checkin.ts";
import { checkInSettings, localTime } from "../../src/checkin-settings.ts";
import { CorrectionLedger, repeatsBetween } from "../../src/chat-corrections.ts";
import { fileOwnerTexts } from "../../src/owner-history.ts";
import { placeholderTodo } from "../../src/shared/chat-board.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { JOB_NOTICE_PREFIX, serverNote } from "../../src/shared/chat-feed.ts";
import { agentMessageSender } from "../../src/no-report.ts";
import { isPromptCustom, messageText } from "../../src/shared/turns.ts";
import type { ThreadMessage } from "../../src/shared/types.ts";
import { boardClasses, daemonSessions, type DaemonSession } from "./board-classes.ts";
import { dutyFleet } from "./duty-fleet.ts";
import { endStateKpi, endStateLine, OK_STATES, stuckLine } from "../../src/checkin-end-state.ts";
import { fixCommits, recheckSlices } from "./chat-health-recheck.ts";
import { noProgressHours, ownerBoardAsk, stuckPastCheckIn, stuckStepHours, unfixedFlags } from "./checkin-quality.ts";
import { OpsReader, unapplied } from "../../src/checkin-ops.ts";

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
/**
 * The note the pool's extension appends to an error it retries, on another account ("; the retry uses") or on the session's own slot ("this session
 * waits for its slot at", Prime sleeps until then): on a provider error the provider failed, not sieun-pi; on a token hook failure it is a break only
 * if the retry also fails. 10-13: all 87 breaks were such waits (78 provider 429s, 9 hook slot waits), each counted because the slot note was not read.
 */
const POOL_RETRY_NOTE = / pi-pool: [\s\S]*(?:; the retry uses |this session waits for its slot at )[\s\S]*$/;
const BOARD_PREFIX = "[board] ";
const BOARD_ANSWER = " and answered: ";
const SKILL_BLOCK = /<skill\b[^>]*>[\s\S]*?<\/skill>/g;
const SIEUN_PI = /pi-pool|sieun-pi|user-history/i;
const WATCH_MS = 7 * WINDOW_MS;

type Metrics = { corrections: number; repeat_corrections: number; placeholder_todos: number; dead_hours: number; unretried_errors: number; off_brief: number; sieun_pi_breaks: number; recurred: number; unfixed_flags: number; owner_board_asks: number; no_progress_hours: number; checkin_ops_dropped: number; end_state_pct: number;
  duties_green_pct: number; stuck_duties: number; steps_moving_pct: number; stuck_step_hours: number; open_step_hours: number; stuck_after_checkin: number; owner_paused_stuck: number; checkin_not_running: number } & ConvergenceMisses;
type Kind = keyof Metrics | "recheck";
/** A problem the run saw, by a signature that stays the same when it happens again; the next runs watch for it. */
interface Seen { signature: string; slice: FlaggedSlice }
/** The duty's state between runs: each watched signature, when a run first flagged it, and the window end of the last run that did. */
type Watch = Record<string, { firstAt: number; lastRun: number }>;
interface Failure { at: number; reason: string }
interface Tally { metrics: Metrics; deadMs: number; flagged: Map<Kind, FlaggedSlice[]>; seen: Seen[] }

const clip = (text: string): string => text.slice(0, EXCERPT);
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
  let failure: Failure | undefined;
  const ops = new OpsReader();
  /** The latest token hook failure the pool queued a retry for. It is a break only if the turn ends on it; a later request that gets past the hook clears it. */
  let hookRetry: Failure | undefined;

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
    ops.read(message);
    // A job's message ends its silence, so the next [job] line about it is a new notice, as `noticeStands` sends it (Crawler VP 10-14: lab compose
    // additions answered the 08:58Z status ask at 08:59Z, went quiet after 10:09Z, and the new ask at 11:40Z counted as off_brief).
    const sender = message.role === "custom" && message.customType === "agent_message" ? agentMessageSender(messageText(message)) : undefined;
    if (sender) for (const text of seen) if (text.startsWith(`${JOB_NOTICE_PREFIX}${sender} `)) seen.delete(text);
    if (message.role === "user") {
      settleFailure(at);
      const text = messageText(message).trim();
      // A server note (the revive's "[check-in] Your last turn failed ...") or an agent message lands while Prime still retries the hook, so
      // only the owner's own message, or the transcript's end, ends a turn on a hook failure. 10-12: all 3 breaks were hooks killed in
      // lid-closed dark wakes (pmset 17:13:37 to 17:13:57, 18:45:26 to 18:45:35, 19:19:00 to 19:19:02 KST) whose turns ran again at the
      // next full wake, each counted because a note came between.
      if (!serverNote(text)) settleHookRetry();
      if (serverNote(text)) {
        if (!inWindow(at)) continue;
        if (seen.has(text)) { tally.metrics.off_brief++; flag("off_brief", at, `repeated line: ${text}`, signature("repeat", text)); }
        seen.add(text);
        continue;
      }
      const own = ownerWords(text);
      if (inWindow(at) && own && CORRECTION.test(own.replace(QUOTED, ""))) { tally.metrics.corrections++; flag("corrections", at, own); }
      // owner_board_asks: the owner had to ask the chat to tidy its plan, which the check-in should keep tidy (owner 10-12: remove the odd leftover steps and tidy the plan hierarchy).
      if (inWindow(at) && own && ownerBoardAsk(own.replace(QUOTED, ""))) { tally.metrics.owner_board_asks++; flag("owner_board_asks", at, own); }
    } else if (message.role === "assistant") {
      failure = undefined;
      hookRetry = undefined;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        failure = { at, reason: message.errorMessage?.trim() || `stopReason ${message.stopReason}` };
        if (SIEUN_PI.test(failure.reason.replace(POOL_RETRY_NOTE, ""))) {
          if (POOL_RETRY_NOTE.test(failure.reason)) hookRetry = failure;
          else if (inWindow(at)) breakSieunPi(failure);
        }
      }
    } else if (message.role === "custom" && isPromptCustom(message)) {
      settleFailure(at);
    }
  }
  settleFailure(undefined);
  settleHookRetry();
  // checkin_ops_dropped: a duty job's board ops the chat left off the board through the turn that read them and the [board] line's turn after it.
  for (const report of ops.reports.filter(report => report.ended && inWindow(report.at))) {
    const left = unapplied(report);
    if (!left.length) continue;
    tally.metrics.checkin_ops_dropped += left.length;
    flag("checkin_ops_dropped", report.at, `${left.length} of ${report.ops.size} board ops from ${report.from} not applied${report.asked ? " after the [board] line" : ""}: ${left.join(", ")}`);
  }
  return true;
}

/**
 * `placeholder_todos` (correction c14, owner 10-09: "what the fuck is  this???"): each open agent todo with no choices that only holds a place
 * for something not ready (`placeholderTodo`). For you holds only what the owner must decide or do now.
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

/**
 * The declared metrics first: stuck duties, then the steps left stuck longest by a check-in today and the ones stuck now (up to 2 FEW each), corrections given again, sieun-pi breaks (up to FEW) and
 * recurrences; then the per-chat end state lines, chats whose check-in the owner paused, yesterday's fixes to recheck, merges without the owner's
 * go, check-in findings left unfixed (the longest streaks, up to FEW), corrections, owner board asks and chats with goals and no duty; then one
 * slice of each other kind in turn, newest first within a kind, up to MAX_FLAGGED.
 */
function pickFlagged(flagged: Map<Kind, FlaggedSlice[]>): FlaggedSlice[] {
  const newest = (kind: Kind, limit = Infinity) => [...(flagged.get(kind) ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
  // goals_without_duty: the duty proposals review of 10-12 found 5 chats with open goals and no duty.
  const picked = [...newest("stuck_duties"), ...(flagged.get("stuck_step_hours") ?? []).slice(0, FEW * 2), ...newest("stuck_after_checkin", FEW * 2), ...newest("repeat_corrections"), ...newest("sieun_pi_breaks", FEW), ...newest("recurred"), ...newest("end_state_pct"),
    ...newest("owner_paused_stuck"), ...newest("recheck"), ...newest("merges_without_go"), ...newest("unfixed_flags", FEW), ...newest("no_progress_hours", FEW), ...newest("checkin_ops_dropped", FEW), ...newest("corrections"),
    ...newest("owner_board_asks"), ...newest("goals_without_duty")].slice(0, MAX_FLAGGED);
  const queues = [newest("stuck_steps", FEW), newest("unretried_errors"), newest("off_brief", 2 * FEW),
    newest("orphan_steps", FEW), newest("due_late", FEW), newest("stale_chase_24h", FEW), newest("job_end_unrecorded", FEW), newest("job_end_silent", FEW), newest("scope_misses", FEW), newest("idle_goals", FEW), newest("goal_gaps", FEW), newest("blocked_on_others", FEW),
    newest("finished_open", FEW), newest("loose_goals", FEW), newest("extra_goals", FEW), newest("open_under_closed", FEW), newest("held_elsewhere", FEW), newest("wait_met", FEW), newest("stale_steps", FEW), newest("goals_to_fold", FEW), newest("one_session_load", FEW), newest("redundant_heartbeats", FEW),
    newest("placeholder_todos", FEW)];
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
  const tally: Tally = { metrics: { corrections: 0, repeat_corrections: 0, placeholder_todos: 0, dead_hours: 0, unretried_errors: 0, off_brief: 0, sieun_pi_breaks: 0, recurred: 0, unfixed_flags: 0, owner_board_asks: 0,
    no_progress_hours: 0, checkin_ops_dropped: 0, end_state_pct: 100, duties_green_pct: 100, stuck_duties: 0, steps_moving_pct: 100, stuck_step_hours: 0, open_step_hours: 0, stuck_after_checkin: 0, owner_paused_stuck: 0, checkin_not_running: 0, ...NO_MISSES },
    deadMs: 0, flagged: new Map(), seen: [] };
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
  const repeats = await repeatsBetween(await new CorrectionLedger(dataDir).read(), now - WINDOW_MS, now,
    chat => fileOwnerTexts(join(sessionsDir, `${chat}.jsonl`)));
  tally.metrics.repeat_corrections = repeats.length;
  tally.flagged.set("repeat_corrections", repeats.map(({ entry, repeat }) => ({ chat: repeat.chat.id, at: Date.parse(repeat.at), kind: "repeat_corrections",
    excerpt: clip(`${entry.id} "${entry.rule}" repeated in ${repeat.chat.name || repeat.chat.id} (first ${entry.at.slice(0, 10)} in ${entry.chat.name || entry.chat.id}): ${repeat.words}`) })));
  // One daemon list for the board classes and the duty fleet.
  let roster: DaemonSession[] | undefined;
  const sessions = (): DaemonSession[] => (roster ??= daemonSessions());
  const chats = await boardClasses({ dataDir, now, sessions, chats: ids });
  // The headline (owner 10-15, c75: "why is duties not all passing?"): the share of duties in all chats whose last run met every target, and the
  // duties that missed CHANGE_APPROACH_MISSES runs in a row with no live fix job (scripts/duties/duty-fleet.ts).
  const fleet = await dutyFleet({ dataDir, now, sessions });
  tally.metrics.duties_green_pct = fleet.metrics.duties_green_pct;
  tally.metrics.stuck_duties = fleet.metrics.stuck_duties;
  tally.flagged.set("stuck_duties", fleet.flagged);
  for (const chat of chats) {
    for (const [key, value] of Object.entries(chat.misses) as [keyof ConvergenceMisses, number][]) tally.metrics[key] += value;
    for (const slice of chat.flagged) { const list = tally.flagged.get(slice.kind as Kind) ?? []; list.push(slice); tally.flagged.set(slice.kind as Kind, list); }
  }
  // The headline KPI (owner 10-14): the share of all open steps that are moving, in For you or parked, and one line per chat with its stuck split.
  tally.metrics.end_state_pct = endStateKpi(chats.flatMap(chat => chat.end)).pct;
  tally.flagged.set("end_state_pct", chats.filter(chat => chat.kpi.stuck).sort((a, b) => b.kpi.stuck - a.kpi.stuck)
    .map(chat => ({ chat: chat.id, at: now, kind: "end_state_pct", excerpt: `${chat.name}: ${endStateLine(chat.kpi)}` })));
  // The headline (c64, c75): the share of the day's open step-hours not left stuck by a check-in (`stuckStepHours`), over the chats whose
  // check-in the owner did not pause. end_state_pct above stays the plain snapshot of every chat; stuck_after_checkin is the board now.
  const settings = checkInSettings(join(dataDir, "check-in-settings.json"));
  let openHours = 0;
  let stuckHours = 0;
  const hours: { hours: number; slice: FlaggedSlice }[] = [];
  const left: FlaggedSlice[] = [];
  const paused: FlaggedSlice[] = [];
  for (const chat of chats) {
    const setting = await settings.get(chat.id);
    const day = await stuckStepHours(dataDir, chat.id, setting, now - WINDOW_MS, now);
    openHours += day.openHours;
    stuckHours += day.stuckHours;
    for (const step of day.steps) hours.push({ hours: step.hours, slice: { chat: chat.id, at: step.since, kind: "stuck_step_hours", item: step.item,
      excerpt: clip(`${chat.name}: ${step.hours.toFixed(1)} h left stuck by a check-in since ${localTime(step.since)}. ${step.excerpt}`) } });
    const stuck = chat.end.filter(entry => !OK_STATES.has(entry.state));
    const past = await stuckPastCheckIn(dataDir, chat.id, stuck.map(entry => entry.view.item.id), setting, now);
    if (past.stand === "owner_paused") {
      tally.metrics.owner_paused_stuck += stuck.length;
      if (stuck.length) paused.push({ chat: chat.id, at: now, kind: "owner_paused_stuck", excerpt: clip(`${chat.name}: the owner paused its check-in; ${endStateLine(chat.kpi)}`) });
      continue;
    }
    if (past.stand === "not_running" && chat.end.length) tally.metrics.checkin_not_running++;
    for (const { item, since, runs } of past.left) {
      const entry = stuck.find(candidate => candidate.view.item.id === item)!;
      const why = past.stand === "not_running" ? `its check-in has not run since ${past.lastAt !== undefined ? localTime(past.lastAt) : "it was set up"}`
        : `${runs} check-ins in a row since ${localTime(since)} left it stuck`;
      left.push({ chat: chat.id, at: since, kind: "stuck_after_checkin", item, excerpt: clip(`${chat.name}: ${why}. ${stuckLine(entry, now)}`) });
    }
  }
  // Floored to a tenth, so any step-hour left stuck reads under 100%.
  tally.metrics.steps_moving_pct = openHours ? Math.floor(1000 * (1 - stuckHours / openHours)) / 10 : 100;
  tally.metrics.stuck_step_hours = tenth(stuckHours);
  tally.metrics.open_step_hours = Math.round(openHours);
  tally.metrics.stuck_after_checkin = left.length;
  tally.flagged.set("stuck_step_hours", hours.sort((a, b) => b.hours - a.hours).map(entry => entry.slice));
  tally.flagged.set("stuck_after_checkin", left);
  tally.flagged.set("owner_paused_stuck", paused);
  const watch = watchRecurrences(tally.seen, await readWatch(process.env.STATE_FILE), now, tally);
  const fixes = fixCommits(process.env.CHAT_HEALTH_GIT_DIR || join(import.meta.dirname, "..", ".."), now - 2 * WINDOW_MS, now - WINDOW_MS);
  tally.flagged.set("recheck", recheckSlices(fixes, { ...tally.metrics }).map(slice => ({ ...slice, excerpt: clip(slice.excerpt) })));
  const result: PrecheckOutput = { metrics: { ...tally.metrics }, flagged: pickFlagged(tally.flagged) };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  if (process.env.STATE_FILE) await writeFile(process.env.STATE_FILE, JSON.stringify({ watch }) + "\n");
}

await main();
