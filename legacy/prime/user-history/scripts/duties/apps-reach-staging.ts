import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Apps reach staging duty's precheck (`node --import tsx scripts/duties/apps-reach-staging.ts`) for the frontend chat. The headline,
 * apps_picked, is how many of the 6 Prospect apps have an owner pick in the 5180 demo's Staging line (apps/virev-demo/lines/staging.json in
 * auto-sns-agent). open_review_max_h is the age of the oldest open review todo the chat put on For you that the chat can still fix (no tap
 * answers yet, or answered and still open); one with tap answers and no reply only waits on the owner and goes to owner_held_review_max_h, run
 * detail. Run detail, not judged: owner_held_review_max_h and each tab's 0 to 100% status (`tabs`), the owner's "report status (in
 * 0%-100%) of each tab". An unreadable Staging line or board fails the run, since neither the headline nor the reviews can be read without it.
 * It reads no CI: 5180 demo work stays on disk and never goes to dev/sieun (owner 10-18: "no need to push at all even. why check for CI?").
 * No model call, no browser.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
export const CHAT_ID = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const BOARD = join(homedir(), ".prime/agent/browser-chat/boards", `${CHAT_ID}.json`);
export const LINE_FILE = "apps/virev-demo/lines/staging.json";
/** The 6 Prospect apps: their key in the Staging line and the word todos and plan steps use for them. */
export const APPS = [
  { key: "home", word: "Home" }, { key: "inbox", word: "Inbox" }, { key: "watchlist", word: "Watchlist" },
  { key: "email", word: "Email" }, { key: "creators", word: "Creators" }, { key: "connections", word: "Connections" },
] as const;
export const SHIPPED = "shipped";
const HOUR_MS = 3_600_000;

export interface StagingLine { apps?: Record<string, { variant?: string; at?: string }>; log?: { at?: string }[] }
export interface BoardTodo { id: string; text?: string; done?: boolean; from?: string; at?: string; step?: string; reply?: string; choices?: string[] }
export interface BoardItem { id: string; text?: string; status?: string; job?: string; children?: BoardItem[] }
export interface Board { plan?: BoardItem[]; todos?: BoardTodo[] }

export interface StagingDeps { now: () => number; read: (path: string) => Promise<string>; repo: string; board: string }

const mentions = (text: string | undefined, word: string): boolean => new RegExp(`\\b${word}\\b`).test(text ?? "");

/** Each app's Staging variant, and whether it is an owner pick: any variant other than the shipped page counts. A missing app is shipped. */
export function picks(line: StagingLine): { key: string; word: string; variant: string; picked: boolean; at?: string }[] {
  return APPS.map(app => {
    const entry = line.apps?.[app.key];
    const variant = entry?.variant ?? SHIPPED;
    return { ...app, variant, picked: variant !== SHIPPED, ...(entry?.at ? { at: entry.at } : {}) };
  });
}

/**
 * Hours an app with no pick has waited for a new review todo: 0 while an agent todo naming the app is open (the owner has it), else the hours
 * since the newest agent todo naming it, else the hours since `since` (the Staging line's first log entry).
 */
export function reviewWait(todos: readonly BoardTodo[], word: string, now: number, since: number): { hours: number; last?: BoardTodo; open?: BoardTodo } {
  const named = todos.filter(todo => todo.from === "agent" && mentions(todo.text, word) && todo.at && Number.isFinite(Date.parse(todo.at)));
  const open = named.find(todo => !todo.done);
  if (open) return { hours: 0, open };
  const last = named.sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))[0];
  const from = last ? Date.parse(last.at!) : since;
  return { hours: Number.isFinite(from) ? Math.max(0, Math.round((now - from) / HOUR_MS * 10) / 10) : 0, ...(last ? { last } : {}) };
}

/** Open plan steps (todo, doing or blocked) whose text names the app, with their job, so the duty job sees work already in flight. */
export function openSteps(plan: readonly BoardItem[], word: string): string[] {
  const found: string[] = [];
  const walk = (items: readonly BoardItem[]) => {
    for (const item of items) {
      if (["todo", "doing", "blocked"].includes(item.status ?? "") && mentions(item.text, word)) found.push(item.job ? `${item.id} (job ${item.job})` : item.id);
      walk(item.children ?? []);
    }
  };
  walk(plan);
  return found;
}

/** A review ask: an agent todo that names one of the 6 apps or asks to review or pick (t27 on 10-15 says "List app", not "Creators"). */
export const isReview = (todo: BoardTodo): boolean => todo.from === "agent"
  && (APPS.some(app => mentions(todo.text, app.word)) || /\b(review|pick|put in line)\b/i.test(todo.text ?? ""));

/**
 * Whether an open review only waits on the owner's tap: it has tap answers (`choices`) and no reply. The duty job's fixes for an old review
 * are to check off one he answered and to cut it to one-tap items, so neither is left to do, the same way the check-in counts a goal held by
 * an open For you todo as owner-held (`ownerHeld`). On 10-18 Email t25 read 92.3 h with choices added in place and no answer, and its refresh
 * step p194 was done.
 */
export const ownerHeldReview = (todo: BoardTodo): boolean => !todo.reply && (todo.choices?.length ?? 0) > 0;

/** Open review todos on For you, oldest first, with their age in hours (one decimal) and whether only the owner's tap holds them. */
export function openReviews(todos: readonly BoardTodo[], now: number): { todo: BoardTodo; hours: number; held: boolean }[] {
  return todos.filter(todo => !todo.done && isReview(todo) && Number.isFinite(Date.parse(todo.at ?? "")))
    .map(todo => ({ todo, hours: Math.max(0, Math.round((now - Date.parse(todo.at!)) / HOUR_MS * 10) / 10), held: ownerHeldReview(todo) }))
    .sort((a, b) => b.hours - a.hours);
}

export interface TabStatus { key: string; word: string; pct: number; picked: boolean; done: string[]; open: string[] }

/**
 * Each tab's 0 to 100% status: its owner pick on Staging counts as one step, plus every plan step whose text names the tab (dropped steps
 * left out), and the status is the done share. A tab reads 100% only with a pick and every named step done. On 10-15 09:2xZ the board gave
 * Home 6 of 7, Email 6 of 9.
 */
export function tabStatus(plan: readonly BoardItem[], app: { key: string; word: string; picked: boolean }): TabStatus {
  const done: string[] = [];
  const open: string[] = [];
  const walk = (items: readonly BoardItem[]) => {
    for (const item of items) {
      if (mentions(item.text, app.word)) {
        if (item.status === "done") done.push(item.id);
        else if (["todo", "doing", "blocked"].includes(item.status ?? "")) open.push(item.id);
      }
      walk(item.children ?? []);
    }
  };
  walk(plan);
  const pct = Math.round(100 * (done.length + (app.picked ? 1 : 0)) / (done.length + open.length + 1));
  return { key: app.key, word: app.word, pct, picked: app.picked, done, open };
}

export interface StagingOutput extends PrecheckOutput { tabs: TabStatus[] }

export async function measureStaging(deps: StagingDeps): Promise<StagingOutput> {
  const at = deps.now();
  const flagged: FlaggedSlice[] = [];
  // Targets in apps-reach-staging.duty.json and their sources. apps_picked at least 6 is the headline: the 6 Prospect apps (board goal p14
  // targets 6) and the owner's "get an accepted version of each app in the prospects view". open_review_max_h at most 48: the review limit the
  // duty has held since 10-12; incident, the board went from t5 (2026-10-09T12:38Z) to t11 (2026-10-12T05:55Z), 65 h with nothing to pick, and
  // on 2026-10-12T13:34Z the owner asked "what should i review?". owner_held_review_max_h is run detail.
  const metrics: Record<string, number> = { apps_picked: 0, open_review_max_h: 0, owner_held_review_max_h: 0 };
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const readJson = async <T>(path: string, what: string): Promise<T> => {
    try { return JSON.parse(await deps.read(path)) as T; } catch (error) { throw new Error(`${what} ${path}: ${message(error)}`); }
  };
  const line = await readJson<StagingLine>(join(deps.repo, LINE_FILE), "Staging line");
  const board = await readJson<Board>(deps.board, "board");

  const apps = picks(line);
  metrics.apps_picked = apps.filter(app => app.picked).length;
  const since = Math.min(...(line.log ?? []).map(entry => Date.parse(entry.at ?? "")).filter(Number.isFinite), at);
  for (const app of apps) {
    if (app.picked) { flagged.push({ at, kind: "picked", item: app.key, excerpt: `${app.word}: Staging points at ${app.variant}${app.at ? ` since ${app.at}` : ""}` }); continue; }
    const wait = reviewWait(board.todos ?? [], app.word, at, since);
    const todo = wait.open ? `open review todo ${wait.open.id} from ${wait.open.at}` : wait.last ? `last review todo ${wait.last.id} at ${wait.last.at}, done, ${wait.hours} h ago` : `no review todo yet, ${wait.hours} h since the line started`;
    const steps = openSteps(board.plan ?? [], app.word);
    flagged.push({ at, kind: "no_pick", item: app.key, excerpt: `${app.word}: Staging points at shipped; ${todo}; open steps: ${steps.join(", ") || "none"}` });
  }

  const reviews = openReviews(board.todos ?? [], at);
  metrics.open_review_max_h = reviews.find(review => !review.held)?.hours ?? 0;
  metrics.owner_held_review_max_h = reviews.find(review => review.held)?.hours ?? 0;
  for (const { todo, hours, held } of reviews) {
    flagged.push({ at, kind: held ? "owner_held_review" : "open_review", ...(todo.step ? { item: todo.step } : {}),
      excerpt: `${todo.id} open ${hours} h${held ? ", waits on the owner's tap" : ""} (since ${todo.at}${todo.step ? `, step ${todo.step}` : ""}): ${(todo.text ?? "").slice(0, 160)}` });
  }

  const tabs = apps.map(app => tabStatus(board.plan ?? [], app));
  for (const tab of tabs) {
    flagged.push({ at, kind: "tab_status", item: tab.key, excerpt: `${tab.word} ${tab.pct}%: ${tab.picked ? "owner pick on Staging" : "no pick on Staging"}, ` +
      `${tab.done.length} of ${tab.done.length + tab.open.length} board steps done${tab.open.length ? `; open: ${tab.open.join(", ")}` : ""}` });
  }

  return { metrics, flagged, tabs };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("apps-reach-staging: OUTPUT_FILE is not set\n"); process.exit(2); }
  const result = await measureStaging({ now: Date.now, read: path => readFile(path, "utf8"), repo: REPO, board: BOARD });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
