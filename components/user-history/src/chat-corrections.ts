import { join } from "node:path";
import { missing, readJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { refineCovers } from "./correction-refine.ts";
import { normal } from "./shared/brief-check.ts";

export const CORRECTION_TOOL = "correction_add";
export const CORRECTIONS_FILE = "corrections.json";
/** The chats clean-room.ts opened (an IdIndex), and the scratch ledger their correction_add writes to, so words the script sent never reach the real one. */
export const CLEAN_ROOM_CHATS_FILE = "clean-room-chats.json";
export const CLEAN_ROOM_CORRECTIONS_FILE = "corrections.clean-room.json";
export const ENFORCEMENTS = ["brief", "code", "test"] as const;
export const CORRECTION_STATUSES = ["active", "reopened", "retired"] as const;
export type Enforcement = typeof ENFORCEMENTS[number];
export type CorrectionStatus = typeof CORRECTION_STATUSES[number];

export interface ChatRef { id: string; name: string }
export interface CorrectionRepeat { at: string; chat: ChatRef; words: string }
export interface Correction {
  id: string;
  at: string;
  chat: ChatRef;
  /** The owner's message, verbatim. */
  words: string;
  /** The rule in one plain line, as every chat reads it. */
  rule: string;
  enforcedBy: Enforcement;
  /** The brief bullet, file, commit or test that enforces the rule. */
  ref: string;
  status: CorrectionStatus;
  /** Key words a later correction on the same thing shares. */
  theme: string[];
  repeats: CorrectionRepeat[];
  /** The thread that owns this work: a step on its topics in any other chat is handed off to it (`handoffSteps`, the check-in's scope line). */
  handoff?: Handoff;
}
/** A thread (its name or id, as `waitTarget` resolves it) and the key words of the work that belongs to it. */
/** Where a handed-off job runs. */
export const ENVIRONMENTS = ["local", "staging", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
/**
 * The scope of a handoff. `with`: when set, a step flags only if its text also names one of these words, such as the services the rule names
 * (10-10, c36: 'CI health check' is not a local uptime check). `env`: when set, a step flags only if it, or the nearest item above it that
 * names an environment, names one of these (10-19, c36 covers the local environment, and Crawler VP's p146 prod health check is its own).
 */
export interface Handoff { to: string; topics: string[]; with?: string[]; env?: Environment[] }
export interface Ledger { corrections: Correction[] }

/** A new correction from the owner. */
/** `notRepeatOf`: ids the calling chat says this is no repeat of; the match skips them. */
export interface CorrectionInput { words: string; rule: string; theme: string[]; enforcedBy: Enforcement; ref: string; handoff?: Handoff; notRepeatOf?: string[] }
/** A fix that landed, a retired rule or a reworded rule: the entry's rule, enforcement, ref, status or handoff change; an absent field stays as it is. */
export interface CorrectionFix { id: string; rule?: string; enforcedBy?: Enforcement; ref?: string; status?: CorrectionStatus; handoff?: Handoff }
/** A merge folds entry `id` into `into` as a repeat: the chat's call when a rule it filed as new was the same rule after all. */
export type CorrectionCall = { kind: "add"; input: CorrectionInput } | { kind: "fix"; fix: CorrectionFix } | { kind: "merge"; id: string; into: string };
export type CorrectionOutcome =
  | { kind: "added"; entry: Correction; closest?: Correction }
  | { kind: "repeat"; entry: Correction; repeat: CorrectionRepeat }
  | { kind: "known"; entry: Correction }
  | { kind: "fixed"; entry: Correction };

const STOP = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "its", "of", "on", "or", "the", "to", "with",
  "this", "that", "what", "when", "who", "how", "do", "does", "not", "no", "only", "must", "should", "never", "always", "every", "each", "chat", "owner"]);
const stem = (word: string): string => word.length > 4 && word.endsWith("ies") ? word.slice(0, -3) + "y"
  : word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

/** The theme's key words: lowercase, stop words dropped, a plural folded to its singular, each once. */
export function themeTokens(theme: string | readonly string[]): string[] {
  const text = typeof theme === "string" ? theme : theme.join(" ");
  return [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => !STOP.has(word)).map(stem))];
}

/**
 * Words that name the surfaces every kind of rule touches, so sharing one says nothing about meaning. On 10-15 ops guy filed a rule about
 * where each decision goes on the board with theme "board", and the ledger reopened c61 (plain board titles).
 */
const GENERIC = new Set(["board", "plan", "title", "note", "step", "goal", "todo", "thread", "job", "rule", "agent", "ci", "repo", "code"]);
const FILLER = new Set(["like", "use", "one", "you", "his", "him", "he", "they", "them", "their", "then", "than", "so", "but", "if", "all", "any", "also"]);
const keyWords = (words: readonly string[]): string[] => words.filter(word => !GENERIC.has(word));
const shared = (a: readonly string[], b: readonly string[]): number => { const other = new Set(b); return a.filter(word => other.has(word)).length; };

/**
 * Whether two themes name the same thing: past the generic words, they share at least two key words and at least half of the shorter theme.
 * A one-word theme matches nothing. Returns the shared count, 0 for no match.
 */
export function themeOverlap(a: readonly string[], b: readonly string[]): number {
  const [left, right] = [keyWords(a), keyWords(b)];
  const count = shared(left, right);
  return count >= 2 && count * 2 >= Math.min(left.length, right.length) ? count : 0;
}

/** The key words of a rule line: theme tokens past the generic and filler words and one-letter scraps. */
const ruleWords = (rule: string): string[] => keyWords(themeTokens(rule)).filter(word => word.length > 1 && !FILLER.has(word));
/** The key words a new rule line shares with an entry's rule and theme; a repeat shares at least two. */
export const ruleOverlap = (rule: string, entry: Correction): number => shared(ruleWords(rule), [...ruleWords(entry.rule), ...keyWords(entry.theme)]);

/**
 * The entry a new rule repeats, any status: its theme matches (`themeOverlap`) and its rule line shares two key words with that entry's rule
 * and theme (`ruleOverlap`). Of those, the one sharing the most theme words, the newest on a tie. `skip` holds ids the chat said it is no
 * repeat of.
 */
export function matchCorrection(ledger: Ledger, theme: readonly string[], rule: string, skip: ReadonlySet<string> = new Set()): Correction | undefined {
  let best: Correction | undefined;
  let bestShared = 0;
  for (const entry of ledger.corrections) {
    if (skip.has(entry.id)) continue;
    const count = themeOverlap(theme, entry.theme);
    if (count > 0 && ruleOverlap(rule, entry) >= 2 && count >= bestShared) { best = entry; bestShared = count; }
  }
  return best;
}

/** The nearest entry a new rule did not repeat, for the chat to judge: the most shared theme words, generic ones too, then rule words. */
export function closestCorrection(ledger: Ledger, theme: readonly string[], rule: string, skip: ReadonlySet<string> = new Set()): Correction | undefined {
  let best: Correction | undefined;
  let bestScore: [number, number] = [0, 0];
  for (const entry of ledger.corrections) {
    if (skip.has(entry.id)) continue;
    const score: [number, number] = [shared(theme, entry.theme), ruleOverlap(rule, entry)];
    if (score[0] + score[1] > 0 && (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] >= bestScore[1]))) { best = entry; bestScore = score; }
  }
  return best;
}

/** A text as `ownerSaid` compares it: straight quotes, no case, and sentence punctuation dropped, with one space per run of whitespace. */
const quoteForm = (text: string): string => normal(text).toLowerCase().replace(/[.,!?;:]+(?=\s|$)/g, "").replace(/\s+/g, " ").trim();
/**
 * Whether `words` is part of one owner message of the chat (`owner`, from `ownerTexts`), compared in `quoteForm`. A note in square brackets
 * is the chat's, such as "[screenshot of the duties panel: ...]" for an image the owner sent with c32's repeat: the words around it must each
 * be in that one message. An ellipsis is a cut the chat made, the same way: ops guy's c110 line of 10-18 quotes "a duty that checks these.
 * ... things like p240" from one longer owner message. Sentence punctuation does not count, since a chat that joins two of his lines adds a
 * period: c118's repeat in frontend bro on 10-19 reads "대충하는거 같잖아. use subagent" where he wrote "대충하는거 같잖아" and "use subagen" on
 * their own lines.
 */
export function ownerSaid(words: string, owner: readonly string[]): boolean {
  const pieces = words.split(/\[[^\]]*\]|\.\.\.|…/).map(piece => quoteForm(piece).replace(/^["'\s]+|["'\s]+$/g, "")).filter(Boolean);
  return pieces.length > 0 && owner.some(text => { const form = quoteForm(text); return pieces.every(piece => form.includes(piece)); });
}

const sameWords = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
const nextId = (ledger: Ledger): string => `c${1 + Math.max(0, ...ledger.corrections.map(entry => Number(entry.id.slice(1)) || 0))}`;

/**
 * Applies one call to the ledger in place. The same verbatim words again (a retried call, a second backfill) change nothing. A theme that
 * matches an entry records a repeat on it and reopens it; otherwise a new active entry.
 */
export function applyCorrection(ledger: Ledger, call: CorrectionCall, chat: ChatRef, at: string): CorrectionOutcome {
  if (call.kind === "merge") return mergeCorrection(ledger, call.id, call.into);
  if (call.kind === "fix") {
    const entry = ledger.corrections.find(item => item.id === call.fix.id);
    if (!entry) throw new Error(`No correction ${call.fix.id}`);
    if (call.fix.rule) entry.rule = call.fix.rule;
    if (call.fix.enforcedBy) entry.enforcedBy = call.fix.enforcedBy;
    if (call.fix.ref) entry.ref = call.fix.ref;
    if (call.fix.status) entry.status = call.fix.status;
    if (call.fix.handoff) entry.handoff = call.fix.handoff;
    return { kind: "fixed", entry };
  }
  const { input } = call;
  const skip = new Set(input.notRepeatOf ?? []);
  // One owner message can repeat two corrections ("unslop ... where is the link?"): the same words count once per entry their theme matches.
  const recorded = (entry: Correction) => !skip.has(entry.id) && (sameWords(entry.words, input.words) || entry.repeats.some(repeat => sameWords(repeat.words, input.words)));
  // A retry that says "not a repeat of cN" takes back the repeat the first call put on cN, and cN with no repeat left is active again.
  for (const entry of ledger.corrections.filter(item => skip.has(item.id))) {
    const kept = entry.repeats.filter(repeat => !sameWords(repeat.words, input.words));
    if (kept.length === entry.repeats.length) continue;
    entry.repeats = kept;
    if (!kept.length && entry.status === "reopened") entry.status = "active";
  }
  const earlier = matchCorrection(ledger, input.theme, input.rule, skip);
  const known = earlier ? (recorded(earlier) ? earlier : undefined) : ledger.corrections.find(recorded);
  if (known) return { kind: "known", entry: known };
  if (earlier) {
    const repeat = { at, chat, words: input.words };
    earlier.repeats.push(repeat);
    earlier.status = "reopened";
    if (input.handoff && !earlier.handoff) earlier.handoff = input.handoff;
    return { kind: "repeat", entry: earlier, repeat };
  }
  const entry: Correction = { id: nextId(ledger), at, chat, words: input.words, rule: input.rule, enforcedBy: input.enforcedBy, ref: input.ref,
    status: "active", theme: input.theme, repeats: [], ...(input.handoff ? { handoff: input.handoff } : {}) };
  const closest = closestCorrection(ledger, input.theme, input.rule, skip);
  ledger.corrections.push(entry);
  return { kind: "added", entry, ...(closest ? { closest } : {}) };
}

/** Folds entry `id` into `into`: its words and repeats become repeats of `into`, which reopens, and `id` leaves the ledger. */
function mergeCorrection(ledger: Ledger, id: string, into: string): CorrectionOutcome {
  const from = ledger.corrections.find(entry => entry.id === id);
  const target = ledger.corrections.find(entry => entry.id === into);
  if (!from) throw new Error(`No correction ${id}`);
  if (!target || target === from) throw new Error(`No other correction ${into} to merge ${id} into`);
  const repeat = { at: from.at, chat: from.chat, words: from.words };
  target.repeats.push(repeat, ...from.repeats);
  target.status = "reopened";
  ledger.corrections.splice(ledger.corrections.indexOf(from), 1);
  return { kind: "repeat", entry: target, repeat };
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${field} is one of ${allowed.join(", ")}`);
  return value as T;
};

/** A handoff argument or field: `to` a thread name or id, `topics` a list or a comma-separated string of key words or phrases. Throws on a bad one. */
export function parseHandoff(value: unknown): Handoff {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const list = Array.isArray(record.topics) ? record.topics : typeof record.topics === "string" ? record.topics.split(",") : [];
  const topics = [...new Set(list.filter((topic): topic is string => typeof topic === "string").map(topic => topic.replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (!topics.length) throw new Error("handoff.topics needs key words");
  const withList = Array.isArray(record.with) ? record.with : typeof record.with === "string" ? record.with.split(",") : [];
  const withWords = [...new Set(withList.filter((word): word is string => typeof word === "string").map(word => word.replace(/\s+/g, " ").trim()).filter(Boolean))];
  const envList = Array.isArray(record.env) ? record.env : typeof record.env === "string" ? record.env.split(",") : [];
  const env = [...new Set(envList.map(name => oneOf(typeof name === "string" ? name.trim() : name, ENVIRONMENTS, "handoff.env")))];
  return { to: text(record.to, "handoff.to"), topics, ...(withWords.length ? { with: withWords } : {}), ...(env.length ? { env } : {}) };
}

const correctionId = (value: unknown, field: string): string => {
  const id = text(value, field);
  if (!/^c\d+$/.test(id)) throw new Error(`${field} is a correction id like c3, not ${id}`);
  return id;
};
/**
 * The tool's arguments: `id` with `mergeInto` folds that entry into another as a repeat; `id` alone marks a fix (rule, enforcedBy, ref, status,
 * handoff); else a new correction (words, rule, theme, ref, an optional enforcedBy that defaults to brief (c81), an optional handoff, and an
 * optional `notRepeatOf`, ids or a comma-separated string of them). A fix that names enforcedBy or ref and no status sets the entry active: the
 * fix landed.
 */
export function parseCorrectionCall(value: unknown): CorrectionCall {
  const input = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const handoff = input.handoff === undefined ? {} : { handoff: parseHandoff(input.handoff) };
  if (input.id !== undefined) {
    const id = correctionId(input.id, "id");
    if (input.mergeInto !== undefined) return { kind: "merge", id, into: correctionId(input.mergeInto, "mergeInto") };
    const landed = input.enforcedBy !== undefined || input.ref !== undefined;
    const status = input.status !== undefined ? oneOf(input.status, CORRECTION_STATUSES, "status") : landed ? "active" : undefined;
    if (!status && !landed && input.handoff === undefined && input.rule === undefined) throw new Error("a fix gives rule, enforcedBy, ref, status or handoff");
    return { kind: "fix", fix: { id, ...(status ? { status } : {}), ...(input.rule === undefined ? {} : { rule: text(input.rule, "rule").replace(/\s+/g, " ") }),
      ...(input.enforcedBy === undefined ? {} : { enforcedBy: oneOf(input.enforcedBy, ENFORCEMENTS, "enforcedBy") }),
      ...(input.ref === undefined ? {} : { ref: text(input.ref, "ref") }), ...handoff } };
  }
  const theme = themeTokens(Array.isArray(input.theme) ? input.theme.filter((word): word is string => typeof word === "string") : text(input.theme, "theme"));
  if (!theme.length) throw new Error("theme needs key words");
  const notRepeatOf = (Array.isArray(input.notRepeatOf) ? input.notRepeatOf : typeof input.notRepeatOf === "string" ? input.notRepeatOf.split(",").filter(id => id.trim()) : [])
    .map(id => correctionId(id, "notRepeatOf"));
  return { kind: "add", input: { words: text(input.words, "words"), rule: text(input.rule, "rule").replace(/\s+/g, " "), theme,
    enforcedBy: input.enforcedBy === undefined ? "brief" : oneOf(input.enforcedBy, ENFORCEMENTS, "enforcedBy"), ref: text(input.ref, "ref"), ...handoff,
    ...(notRepeatOf.length ? { notRepeatOf } : {}) } };
}

/**
 * What the tool tells the chat. A repeat asks for the smallest fix that makes agents follow the rule: a brief, skill or prompt line first, and
 * a code gate only when measured repeats show the text did not hold (c81, owner 10-15: "things like `enforced` here doesn't mean code-level
 * blocks").
 */
export const AUTO_REFINE = "When this turn ends the service refines the global harness on it with /refine, so do not call refine.run for it.";
export function correctionResult(outcome: CorrectionOutcome): string {
  const { entry } = outcome;
  switch (outcome.kind) {
    case "added": return `Recorded ${entry.id}: ${entry.rule} (enforced by ${entry.enforcedBy}: ${entry.ref}). Every chat reads it from its next model call. ${AUTO_REFINE}` +
      (outcome.closest ? ` The closest earlier rule is ${outcome.closest.id} "${outcome.closest.rule}". If the owner repeated that rule, call ${CORRECTION_TOOL} ` +
        `with id "${entry.id}" and mergeInto "${outcome.closest.id}".` : "");
    case "known": return `Already recorded as ${entry.id}: ${entry.rule}. Nothing changed.`;
    case "fixed": return `Updated ${entry.id}: enforced by ${entry.enforcedBy} (${entry.ref}), ${entry.status}` +
      `${entry.handoff ? `; steps on ${entry.handoff.topics.join(", ")}${entry.handoff.env ? ` in ${entry.handoff.env.join(" or ")}` : ""} go to ${entry.handoff.to}` : ""}.`;
    case "repeat": return `Repeat of ${entry.id} "${entry.rule}", first given ${entry.at.slice(0, 10)} in ${entry.chat.name || entry.chat.id}; ` +
      `the owner has now repeated it ${entry.repeats.length} time${entry.repeats.length === 1 ? "" : "s"}, so ${entry.id} is reopened. ${AUTO_REFINE} ` +
      `The earlier fix (${entry.enforcedBy}: ${entry.ref}) did not hold. Make the smallest change that gets agents to follow the rule: first a ` +
      `brief, skill or prompt line where agents read it before they act, and a code gate only when measured repeats show the text did not hold, ` +
      `with those repeats named in the fix (c81). When the fix lands call ${CORRECTION_TOOL} with id "${entry.id}", its enforcedBy and the ref. ` +
      `If the owner gave a different rule, call ${CORRECTION_TOOL} again with notRepeatOf "${entry.id}", which takes this repeat back.`;
  }
}

const ref = (value: unknown): ChatRef => {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return { id: typeof record.id === "string" ? record.id : "", name: typeof record.name === "string" ? record.name : "" };
};
/** A stored handoff, dropped (not the entry) when it is bad. */
const handoffField = (value: unknown): { handoff?: Handoff } => {
  if (value === undefined) return {};
  try { return { handoff: parseHandoff(value) }; } catch { return {}; }
};
/** Reads the file; an entry with a bad field is dropped rather than failing every chat's context. */
export function parseLedger(value: unknown): Ledger {
  const list = typeof value === "object" && value !== null && Array.isArray((value as { corrections?: unknown }).corrections)
    ? (value as { corrections: unknown[] }).corrections : [];
  const corrections: Correction[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.at !== "string" || typeof entry.words !== "string" || typeof entry.rule !== "string" ||
      !ENFORCEMENTS.includes(entry.enforcedBy as Enforcement) || !CORRECTION_STATUSES.includes(entry.status as CorrectionStatus)) continue;
    corrections.push({ id: entry.id, at: entry.at, chat: ref(entry.chat), words: entry.words, rule: entry.rule, enforcedBy: entry.enforcedBy as Enforcement,
      ref: typeof entry.ref === "string" ? entry.ref : "", status: entry.status as CorrectionStatus,
      theme: Array.isArray(entry.theme) ? entry.theme.filter((word): word is string => typeof word === "string") : [],
      repeats: Array.isArray(entry.repeats) ? entry.repeats.flatMap(repeat => typeof repeat === "object" && repeat !== null &&
        typeof (repeat as CorrectionRepeat).at === "string" && typeof (repeat as CorrectionRepeat).words === "string"
        ? [{ at: (repeat as CorrectionRepeat).at, chat: ref((repeat as CorrectionRepeat).chat), words: (repeat as CorrectionRepeat).words }] : []) : [],
      ...handoffField(entry.handoff) });
  }
  return { corrections };
}

/** The ledger file under the chat service's data dir, written under the cross-process lock in locked-json. */
export class CorrectionLedger {
  private readonly file: JsonFile<Ledger>;
  constructor(dataDir: string, name: string = CORRECTIONS_FILE) { this.file = { path: join(dataDir, name), label: "Corrections ledger", parse: parseLedger, initial: () => ({ corrections: [] }) }; }
  get path(): string { return this.file.path; }
  /** The ledger; empty before the first correction. Writes replace the file by rename, so a read without the lock sees a whole ledger. */
  async read(): Promise<Ledger> {
    try { return await readJsonFile(this.file); }
    catch (error) { if (missing(error)) return { corrections: [] }; throw error; }
  }
  async apply(call: CorrectionCall, chat: ChatRef, at: string = new Date().toISOString()): Promise<CorrectionOutcome> {
    return (await transactJsonFile(this.file, ledger => applyCorrection(ledger, call, chat, at))).result;
  }
}

const lastAt = (entry: Correction): string => entry.repeats.at(-1)?.at ?? entry.at;
/** The rules in force: reopened first, then newest first. */
const liveRules = (ledger: Ledger): Correction[] => ledger.corrections.filter(entry => entry.status !== "retired")
  .sort((a, b) => Number(b.status === "reopened") - Number(a.status === "reopened") || lastAt(b).localeCompare(lastAt(a)));
/** A rule's line: its id and the first sentence of its rule. board.corrections("c12") reads the whole entry. */
const shortLine = (entry: Correction): string => `- ${entry.id} ${entry.rule.split(/(?<=[.!?])\s+(?=[A-Z`"])/)[0]!.trim()}`;
/** The correction ids a brief names, like "(c47)": the rules it holds in full. */
export const briefCorrections = (lines: readonly string[]): ReadonlySet<string> => new Set(lines.join("\n").match(/\bc\d+\b/g) ?? []);
/** Code or a test holds the rule: it names one and no fix is pending. */
const landed = (entry: Correction): boolean => entry.enforcedBy !== "brief" && !/^pending\b/i.test(entry.ref);
export const READ_RULE = "Read one in full with board.corrections(\"c12\") in Python, or all with board.corrections().";

/**
 * A chat's rules, reopened first then newest: each one that neither its brief names nor landed code or a test holds, one short line each
 * (`shortLine`), with no count cut (owner 10-18: every arbitrary limit is a soft cap). A reopened rule always shows.
 * Null with none.
 */
export function ledgerPrompt(ledger: Ledger, brief: ReadonlySet<string>): string | null {
  const shown = liveRules(ledger).filter(entry => entry.status === "reopened" || !(brief.has(entry.id) || landed(entry)));
  if (!shown.length) return null;
  return [`[corrections] The owner's corrections in force, live from the ledger. ${READ_RULE}`, ...shown.map(shortLine)].join("\n");
}

export const OUTSIDE_ACTION_RULE = "Before any outside action (an email, a ticket or support reply, a customer message, a post) check these rules; " +
  "c37: nothing goes out without the owner's ok on a For you todo; c79: never ask a vendor's support for help, and never ask the owner to approve that.";
/** The rules a job reads as short lines: outside sends, vendor support, acting directly, the model and no model fallback, writing, Convex, merges and staging. */
export const JOB_RULES: ReadonlySet<string> = new Set(["c18", "c20", "c30", "c31", "c35", "c37", "c47", "c49", "c50", "c79"]);
export function jobLedgerPrompt(ledger: Ledger | null, brief: string = ""): string {
  const ui = uiRuleLine(brief);
  return [`[corrections] The owner's corrections that bind jobs, live from the ledger; every other correction holds in this job too. ${OUTSIDE_ACTION_RULE} ${READ_RULE}`,
    ...(ledger ? liveRules(ledger).filter(entry => JOB_RULES.has(entry.id)).map(shortLine) : []), ...(ui ? [ui] : [])].join("\n");
}

/** A brief about one of auto-sns-agent's app screens: it names the demo or its shared UI, and a word for building or styling a screen. */
const UI_SURFACE = /\b51(?:80|74)\b|apps\/virev-demo|\bvirev-demo\b|\$lib\/ui\b|overlay\/src\/lib|shot-browser/i;
const UI_WORK = /\b(?:(?<!on )(?<!his )screens?|layouts?|redesign\w*|restyl\w*|styling|polish\w*|light and dark|dark mode|spacing|padding|page builders?)\b/i;
const NAMES_DESIGN_SKILL = /frontend[- ]design|frontend-implementation/i;
const NAMES_SHARED_COMPONENTS = /frontend-implementation|\$lib\/ui\b|shared (?:kit|components?|component set)|\bc78\b/i;
export const UI_RULE_LINE = "- c48 This job reads as UI work, so before you design or change a screen read auto-sns-agent's frontend-implementation skill " +
  "(`node scripts/skills/read-skill.mjs workflows/frontend-implementation`), which holds the frontend design rules, the shared $lib/ui components to " +
  "reuse (c78) and the reference app for sibling screens (the Dashboards app). Keep each screen compact with no gray, padded or boxed tables or " +
  "containers, and name that skill in the brief of every builder you start.";
/**
 * The c48 line for a job's [corrections] block: UI_RULE_LINE when its brief reads as UI work and does not name both the frontend design skill
 * and the shared components, else null. The owner gave c48 in frontend bro on 10-12 06:55Z ("use frontend design skill ... never use this gray
 * fat needlessly containerized table") and c78 on 10-15 ("consistent design. always use frontend design skill"), and jobs read neither, since
 * JOB_RULES leaves them out. On 10-19 frontend bro's UI briefs said "Read the frontend design and frontend-implementation skills first" until
 * 08:57Z, none it wrote from 09:01 to 17:11Z named the skill, and at 17:14Z the owner gave c48 again: "it doens't do fat-as-fuck containers
 * fix that ... also frontend design skill please". Of the 2,782 job briefs in us-metal02's session artifacts on 10-20, 5 get the line.
 */
export function uiRuleLine(brief: string): string | null {
  if (!UI_SURFACE.test(brief) || !UI_WORK.test(brief)) return null;
  return NAMES_DESIGN_SKILL.test(brief) && NAMES_SHARED_COMPONENTS.test(brief) ? null : UI_RULE_LINE;
}

/** An owner message or a `/refine` command in a chat's session file, with its time in ms. */
export interface Timed { text: string; at: number }
/** What a chat's session file holds for the repeat count: the owner's words (`ownerTexts`) and each `/refine` the service ran in it. */
export interface ChatHistory { owner: readonly Timed[]; refines: readonly Timed[] }

/**
 * Every repeat in [since, until] the owner gave after the first correction was in force, oldest first, with its entry and the time of his
 * message (`said`): the repeat_corrections_7d count, which repeat-split.ts splits by when the entry's fix landed. A rule is in force from
 * the first `/refine` that names the entry's first words (`refineCovers`), which the
 * service runs in the entry's chat when the turn that recorded it ends, or from the entry's own time when no refine is on record (before c86,
 * 10-15). Two kinds of recorded repeat do not count.
 * 1. Words the owner never wrote in the repeat's chat (`ownerSaid`). Before correction_add checked the words (0da3d4a, 10-12 21:59Z), ops guy
 *    recorded its own notes as repeats: "(brief check, twice on 10-12) ..." on c59 and "(owner rule recalled by the release owner ...)" on c4.
 * 2. Words the owner wrote before the rule was in force, judged by his message's own time and not by when a chat filed it. On 10-18 the owner
 *    wrote "지금 자꾸 Mac에서 껐다켰다 하는 새끼 누구고 왜 그렇게 하는거야" (c103) at 05:16Z, then "Aside쓰면 깜빡이지를 않아 커서를 안가져가거든" at 05:21Z in the
 *    same turn, before the 05:22Z refine. ops guy filed his 09:10Z "stop being paranoid in plan" at 10:53Z as a repeat of c110, which he first
 *    gave at 10:43Z.
 */
export interface CountedRepeat { entry: Correction; repeat: CorrectionRepeat; /** When the owner wrote it, in ms: his message's own time. */ said: number }
export async function repeatsBetween(ledger: Ledger, since: number, until: number, history: (chat: string) => Promise<ChatHistory>): Promise<CountedRepeat[]> {
  const inWindow = ledger.corrections.flatMap(entry => entry.repeats.map(repeat => ({ entry, repeat })))
    .filter(({ repeat }) => { const at = Date.parse(repeat.at); return at >= since && at <= until; });
  const chats = new Map<string, ChatHistory>();
  for (const chat of new Set(inWindow.flatMap(({ entry, repeat }) => [repeat.chat.id, entry.chat.id]).filter(Boolean))) chats.set(chat, await history(chat));
  const inForce = (entry: Correction): number => {
    const refined = (chats.get(entry.chat.id)?.refines ?? []).filter(command => refineCovers(command.text, entry.id, entry.words)).map(command => command.at);
    return refined.length ? Math.min(...refined) : Date.parse(entry.at);
  };
  return inWindow.flatMap(({ entry, repeat }) => {
    const said = (chats.get(repeat.chat.id)?.owner ?? []).filter(message => ownerSaid(repeat.words, [message.text]));
    const filed = said.filter(message => message.at <= Date.parse(repeat.at));
    const message = (filed.length ? filed : said).at(-1);
    return message !== undefined && message.at > inForce(entry) ? [{ entry, repeat, said: message.at }] : [];
  }).sort((a, b) => a.repeat.at.localeCompare(b.repeat.at));
}

/** A handoff in force: the correction that set it (not retired), the thread that owns the work, and its topics. */
export interface HandoffRule extends Handoff { correction: string }
/** The ids of the corrections in force (not retired), for steps a correction parks. */
export const activeCorrections = (ledger: Ledger): string[] => ledger.corrections.filter(entry => entry.status !== "retired").map(entry => entry.id);
export const handoffRules = (ledger: Ledger): HandoffRule[] =>
  ledger.corrections.flatMap(entry => entry.status !== "retired" && entry.handoff ? [{ correction: entry.id, ...entry.handoff }] : []);
