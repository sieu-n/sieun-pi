import { BOARD_LIMITS } from "../shared/chat-board.ts";
import { ERROR_PAUSE_RUNS } from "../shared/chat-duties.ts";
import { REPLY_FOLD_WORDS } from "../shared/chat-feed.ts";
import { CHECK_IN_MAX_MINUTES, CHECK_IN_MIN_MINUTES, type PoolConfig } from "../shared/types.ts";
import { POOL_DEFAULTS, poolValue, type PoolKey } from "./pool-config.ts";

/**
 * Settings > How it works: the rules behind chats and the account pool, each with the value the code uses now. A value the browser bundle can
 * import comes from its module; a value that lives in server code or in pi-pool's pool/base.py is a literal here, and test/how-it-works.test.ts
 * fails when it no longer matches its source.
 */

export type Unit = "ms" | "s" | "percent" | "count" | "words" | "characters";
export interface Quantity { amount: number; unit: Unit }
/** Where a value is set: only in code, in pi-pool's config file (`pi-pool set <key> <value>`), or per chat in the app. */
export type Setting = { kind: "code" } | { kind: "pool-config"; key: PoolKey } | { kind: "chat"; where: string };
/** `file` is relative to the repository root; `symbol` names the constant, with a dotted path into an object. */
export interface Source { file: string; symbol: string }
/** `value` is what the app runs with now; `default` is set only when this Mac's pi-pool config overrides the code default. */
export interface Rule { id: string; title: string; text: string; value: Quantity; default?: Quantity; setting: Setting; source: Source }
export interface Step { title: string; text: string }
export interface Rank { rank: number; name: string; setBy: string; rule: string }
export interface Topic { id: "chats" | "pool" | "order"; label: string; intro: string; diagram: string; steps: Step[]; rules: Rule[] }

const USER_HISTORY = "components/user-history/src/";
const POOL_BASE = "components/pi-pool/pool/base.py";
const q = (amount: number, unit: Unit): Quantity => ({ amount, unit });
const pool = (key: PoolKey): Setting => ({ kind: "pool-config", key });
const CODE: Setting = { kind: "code" };

/** Server-only values (src/checkin-settings.ts, src/checkin-steps.ts, src/chat-checkin.ts, src/chats.ts), checked against their source by the test. */
export const CHECK_IN_MS = 120 * 60_000;
export const STEP_STALE_MS = 2 * 60 * 60_000;
export const NO_REPORT_GRACE_MS = 90_000;
export const PARK_IDLE_MS = 60 * 60_000;

/** `DEFAULTS.max_moves_per_day` and `DEFAULTS.tier_units` in pi-pool's pool/base.py, checked against it by the test. */
export const MOVES_PER_DAY = { high: 6, normal: 3, low: 1 } as const;
export const TIER_UNITS = { "max 20x": 4, "max 5x": 1, team: 1, pro: 0.5 } as const;

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

export function formatQuantity({ amount, unit }: Quantity): string {
  switch (unit) {
    case "ms": return amount % 3_600_000 === 0 ? `${amount / 3_600_000} h` : amount % 60_000 === 0 ? minutes(amount) : `${amount / 1000} s`;
    case "s": return formatQuantity(q(amount * 1000, "ms"));
    case "percent": return `${amount}%`;
    case "count": return String(amount);
    case "words": return `${amount} words`;
    case "characters": return `${amount} characters`;
  }
}

export function settingText({ setting, default: fallback }: Rule): string {
  switch (setting.kind) {
    case "code": return "Set in code";
    case "pool-config": return fallback ? `Set on this Mac (default ${formatQuantity(fallback)}): pi-pool set ${setting.key}` : `Default. Override: pi-pool set ${setting.key}`;
    case "chat": return `Default. Change it in ${setting.where}`;
  }
}

const CHAT_RULES: Rule[] = [
  { id: "check-in-every", title: "Check-in interval", value: q(CHECK_IN_MS, "ms"), setting: { kind: "chat", where: `the chat's Check-in control (${CHECK_IN_MIN_MINUTES} to ${CHECK_IN_MAX_MINUTES} min)` },
    text: "How often the app runs a chat's check-in. A check-in with nothing open starts no job.", source: { file: USER_HISTORY + "checkin-settings.ts", symbol: "CHECK_IN_MS" } },
  { id: "reply-words", title: "Reply length", value: q(REPLY_FOLD_WORDS, "words"), setting: CODE,
    text: "A chat's reply to you aims at this length. A longer reply folds behind More, and a long explanation goes to a linked page.", source: { file: USER_HISTORY + "shared/chat-feed.ts", symbol: "REPLY_FOLD_WORDS" } },
  { id: "open-asks", title: "Open asks in For you", value: q(BOARD_LIMITS.openAsks, "count"), setting: CODE,
    text: "The most questions a chat may leave open for you. Past it the chat decides by itself.", source: { file: USER_HISTORY + "shared/chat-board.ts", symbol: "BOARD_LIMITS.openAsks" } },
  { id: "open-goals", title: "Open goals", value: q(BOARD_LIMITS.openGoals, "count"), setting: CODE,
    text: "Past this many open goals the check-in asks the chat to fold goals of one area. New work goes under the goal it belongs to.", source: { file: USER_HISTORY + "shared/chat-board.ts", symbol: "BOARD_LIMITS.openGoals" } },
  { id: "plan-items", title: "Plan size", value: q(BOARD_LIMITS.planItems, "count"), setting: CODE,
    text: "The most open goals and steps one plan holds. Done and dropped ones do not count.", source: { file: USER_HISTORY + "shared/chat-board.ts", symbol: "BOARD_LIMITS.planItems" } },
  { id: "step-stale", title: "Stale wait", value: q(STEP_STALE_MS, "ms"), setting: CODE,
    text: "A step that waits on another thread or an event with no progress for this long is flagged for the check-in to chase.", source: { file: USER_HISTORY + "checkin-steps.ts", symbol: "STEP_STALE_MS" } },
  { id: "no-report", title: "Job ended with no report", value: q(NO_REPORT_GRACE_MS, "ms"), setting: CODE,
    text: "When a job goes quiet without reporting, the chat is told after this long.", source: { file: USER_HISTORY + "chats.ts", symbol: "NO_REPORT_GRACE_MS" } },
  { id: "job-cleanup", title: "Waiting job cleanup", value: q(PARK_IDLE_MS, "ms"), setting: CODE,
    text: "A finished job is deleted as soon as its report reaches the chat. A job whose only open work is a board wait is deleted after it has been quiet this long, with its brief, last report and wait saved on the step for a fresh job.", source: { file: USER_HISTORY + "chat-checkin.ts", symbol: "PARK_IDLE_MS" } },
  { id: "duty-errors", title: "Duty errors before pause", value: q(ERROR_PAUSE_RUNS, "count"), setting: CODE,
    text: "This many failed duty runs in a row pause the duty until you resume it.", source: { file: USER_HISTORY + "shared/chat-duties.ts", symbol: "ERROR_PAUSE_RUNS" } },
];

const POOL_RULES: Rule[] = [
  { id: "admit-5h", title: "Admit cap, 5-hour window", value: q(POOL_DEFAULTS.admit_5h_max_pct, "percent"), setting: pool("admit_5h_max_pct"),
    text: "An account takes a thread that is not on it only under this share of its 5-hour window. A thread already on it stays.", source: { file: POOL_BASE, symbol: "DEFAULTS.admit_5h_max_pct" } },
  { id: "low-admit-5h", title: "Admit cap for low threads", value: q(POOL_DEFAULTS.low_admit_5h_max_pct, "percent"), setting: pool("low_admit_5h_max_pct"),
    text: "The same cap for a low-priority thread, so duties and check-ins leave room for your chats.", source: { file: POOL_BASE, symbol: "DEFAULTS.low_admit_5h_max_pct" } },
  { id: "admit-week", title: "Admit cap, week", value: q(POOL_DEFAULTS.seven_day_max_pct, "percent"), setting: pool("seven_day_max_pct"),
    text: "An account takes a thread only under this share of its week, and of its weekly Fable cap when the thread runs Fable.", source: { file: POOL_BASE, symbol: "DEFAULTS.seven_day_max_pct" } },
  { id: "admit-slot", title: "Admission slot", value: q(POOL_DEFAULTS.admit_slot_sec, "s"), setting: pool("admit_slot_sec"),
    text: "In this window an account takes one thread per tier unit, and always at least one.", source: { file: POOL_BASE, symbol: "DEFAULTS.admit_slot_sec" } },
  { id: "admit-per-unit", title: "Threads per tier unit", value: q(POOL_DEFAULTS.admit_per_unit, "count"), setting: pool("admit_per_unit"),
    text: "How many threads one tier unit admits per slot window.", source: { file: POOL_BASE, symbol: "DEFAULTS.admit_per_unit" } },
  { id: "budget-wait", title: "Longest wait when out of moves", value: q(POOL_DEFAULTS.budget_wait_max_sec, "s"), setting: pool("budget_wait_max_sec"),
    text: "A thread out of moves waits for its own account only when that account frees within this time. Else it moves anyway.", source: { file: POOL_BASE, symbol: "DEFAULTS.budget_wait_max_sec" } },
  { id: "load-window", title: "Load window", value: q(POOL_DEFAULTS.active_session_sec, "s"), setting: pool("active_session_sec"),
    text: "The score counts the threads an account served in this window as its load.", source: { file: POOL_BASE, symbol: "DEFAULTS.active_session_sec" } },
  { id: "cold", title: "Cold thread", value: q(POOL_DEFAULTS.cache_ttl_sec, "s"), setting: pool("cache_ttl_sec"),
    text: "A thread with no request for this long has lost its prompt cache, so its pin may move it back on the next request.", source: { file: POOL_BASE, symbol: "DEFAULTS.cache_ttl_sec" } },
  { id: "refused", title: "Refusal cooldown", value: q(POOL_DEFAULTS.refused_cooldown_sec, "s"), setting: pool("refused_cooldown_sec"),
    text: "An account the provider refuses (terms not accepted, sign-in turned off) is skipped for this long.", source: { file: POOL_BASE, symbol: "DEFAULTS.refused_cooldown_sec" } },
  { id: "probe", title: "Refusal check", value: q(POOL_DEFAULTS.probe_interval_sec, "s"), setting: pool("probe_interval_sec"),
    text: "At most this often, a starting session checks every Claude account for a refusal with one free request.", source: { file: POOL_BASE, symbol: "DEFAULTS.probe_interval_sec" } },
];

/** The order `decide` in pi-pool's pool/sched.py walks, first match wins, per provider. */
export const ACCOUNT_ORDER: Rank[] = [
  { rank: 1, name: "New pin for this thread", setBy: "Use on an account row, or an account picked for a new chat",
    rule: "Applied once: the next request moves there when the account is under the admit cap and has a free slot. A high thread skips the slot." },
  { rank: 2, name: "Pin for all sessions", setBy: "Pin in an account row's menu",
    rule: "Moves threads to the account one slot at a time while it is under the admit cap." },
  { rank: 3, name: "The thread's own account", setBy: "The thread's last request",
    rule: "Holds while the account serves, warm or cold. A Codex thread moves up to a higher plan with a free slot, and a cold thread goes back to its pin." },
  { rank: 4, name: "Best score", setBy: "A new thread, or a thread whose account stopped serving",
    rule: "Admits the thread to the account with the best score among those under the admit cap with a free slot." },
  { rank: 5, name: "Wait", setBy: "No account takes the thread",
    rule: "The thread gets its own slot on the account that frees first and sleeps until then." },
];

/** A pool rule with this Mac's value when its pi-pool config overrides the default. */
function live(rule: Rule, config: PoolConfig | null): Rule {
  if (rule.setting.kind !== "pool-config") return rule;
  const amount = poolValue(config, rule.setting.key);
  return amount === rule.value.amount ? rule : { ...rule, value: q(amount, rule.value.unit), default: rule.value };
}

/** The topics of the tab; `config` is this Mac's `pi-pool config` (null: pi-pool's defaults). */
export function howTopics(config: PoolConfig | null): Topic[] {
  const admit = poolValue(config, "admit_5h_max_pct");
  const lowAdmit = poolValue(config, "low_admit_5h_max_pct");
  const week = poolValue(config, "seven_day_max_pct");
  const slot = formatQuantity(q(poolValue(config, "admit_slot_sec"), "s"));
  const slots = (units: number): number => Math.max(1, Math.round(poolValue(config, "admit_per_unit") * units));
  const budgetWait = formatQuantity(q(poolValue(config, "budget_wait_max_sec"), "s"));
  return [
  {
    id: "chats", label: "Chats",
    intro: "A chat is a long-running thread for one topic. You talk to it like a coworker. It keeps a board you can see and hands real work to jobs.",
    diagram: `flowchart LR
  you([You]) <-- talk --> chat[Chat]
  chat -- starts --> jobs[Jobs]
  jobs -. reports .-> chat
  chat --- board[(Board)]
  check(["Check-in<br>every ${minutes(CHECK_IN_MS)}"]) --> chat`,
    steps: [
      { title: "You send a message", text: "The chat answers in a few lines. It does only quick look-ups itself." },
      { title: "The board", text: "Plan holds goals and their steps, with the chat's decisions in each step's note. For you holds the questions only you can answer." },
      { title: "Jobs", text: "Real work goes to a job: a subagent, or a thread in another folder. A job reports back to the chat when it ends, fails or gets stuck." },
      { title: "Check-in", text: "On a timer, code lists every open step and what it waits on, with no model call. Then one check-in job reads that list, fixes the plan and restarts stuck work." },
      { title: "Duties", text: "A duty is a standing goal with a schedule. Each run works like a check-in: a code check first, then one job with the result." },
    ],
    rules: CHAT_RULES,
  },
  {
    id: "pool", label: "Account pool",
    intro: "Every thread draws its Claude or Codex sign-in from a pool of accounts. On each request the pool decides one of three things: stay on the thread's account, admit the thread to another account, or make it wait for a slot.",
    diagram: `flowchart LR
  req[Next request] --> own{Own account still serves?}
  own -- yes --> stay([Stay])
  own -- no --> cap{"Account under ${admit}% 5h<br>with a free slot?"}
  cap -- yes --> admit([Admit to the best score])
  cap -- no --> wait([Wait for its own slot])`,
    steps: [
      { title: "Stay", text: "A thread stays on its account while the account serves, which means no 429 and no window at 100%. A move drops the prompt cache, so a cutoff or a better score never moves it." },
      { title: "Admit cap", text: `An account takes a new or moving thread only under ${admit}% of its 5-hour window and ${week}% of its week. No thread enters an account at ${admit}% or more.` },
      { title: "Score", text: "Among the accounts that pass, the thread goes to the best score: weekly pace times 5-hour headroom, divided by load. Weekly pace is the week left over the hours to its reset, so a week that resets soon with room left is spent first." },
      { title: "Slots", text: `Each account takes ${slots(TIER_UNITS["max 20x"])} threads every ${slot} on a Max 20x plan and ${slots(TIER_UNITS["max 5x"])} on the others. Threads that leave one account together enter the next ones at that pace.` },
      { title: "Wait", text: "When no account takes the thread, it gets its own slot on the account that frees first. Waiting threads line up by priority, then by when they began to wait. The turn sleeps until its own slot, not until its old account resets." },
      { title: "Move budget", text: `A normal thread may make ${MOVES_PER_DAY.normal} moves in 24 h and a low one ${MOVES_PER_DAY.low}. Out of moves, it waits for its own account when that frees within ${budgetWait}, and moves anyway when it does not. A high thread always moves when it must.` },
      { title: "Priority", text: `A chat you talk to is high, a job takes its chat's priority, and a duty or check-in run is low. Low threads enter only under ${lowAdmit}% of the 5-hour window. High threads get slots first. When only one account takes threads and it has several slots, the last slot of each window is for high threads.` },
      { title: "Jobs", text: "A subagent uses its root thread's account and never moves alone. A job thread gets its own account when it starts, and stays there while that account serves, even when its chat moves." },
    ],
    rules: POOL_RULES.map(rule => live(rule, config)),
  },
  {
    id: "order", label: "Which account goes first",
    intro: "For each request the pool walks this list from the top and takes the first match. Follow the pool means the thread has no pin of its own.",
    diagram: `flowchart LR
  a[1 Thread pin] --> b[2 Pool pin] --> c[3 Own account] --> d[4 Best score] --> e[5 Wait]`,
    steps: [
      { title: "A thread pin applies once", text: "After that a thread pin steers the thread only when it must move or has gone cold. It never pulls a warm thread back." },
      { title: "Never picked", text: "An account that is Off, needs a login, is limited by a 429, or cools down after a refusal takes no thread." },
      { title: "Codex plans", text: "A new Codex thread goes to the highest plan with a free slot, and a thread on a lower plan moves up when a higher one has a free slot." },
    ],
    rules: [],
  },
  ];
}

/** Every rule at pi-pool's defaults: the values the code sets. */
export const ALL_RULES: Rule[] = howTopics(null).flatMap(topic => topic.rules);
