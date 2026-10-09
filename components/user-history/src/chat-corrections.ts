import { join } from "node:path";
import { missing, readJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";

/**
 * The owner's corrections ledger, `<data dir>/corrections.json`. A chat records each correction with `correction_add` in the turn the owner gives
 * it; every chat reads the active rules from this file before each model call, so a new correction holds in every chat from its next call.
 * A correction whose theme matches an earlier one is a repeat: the earlier fix did not hold.
 */
export const CORRECTION_TOOL = "correction_add";
export const CORRECTIONS_FILE = "corrections.json";
export const ENFORCEMENTS = ["brief", "code", "test"] as const;
export const CORRECTION_STATUSES = ["active", "reopened", "retired"] as const;
export type Enforcement = typeof ENFORCEMENTS[number];
export type CorrectionStatus = typeof CORRECTION_STATUSES[number];
/** At most this many rules reach a chat's context; older ones stay in the file. */
export const LEDGER_PROMPT_LINES = 40;

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
export interface Handoff { to: string; topics: string[] }
export interface Ledger { corrections: Correction[] }

/** A new correction from the owner. */
export interface CorrectionInput { words: string; rule: string; theme: string[]; enforcedBy: Enforcement; ref: string; handoff?: Handoff }
/** A fix that landed (or a retired rule): the entry's enforcement, ref, status or handoff change; an absent field stays as it is. */
export interface CorrectionFix { id: string; enforcedBy?: Enforcement; ref?: string; status?: CorrectionStatus; handoff?: Handoff }
export type CorrectionCall = { kind: "add"; input: CorrectionInput } | { kind: "fix"; fix: CorrectionFix };
export type CorrectionOutcome =
  | { kind: "added"; entry: Correction }
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
 * Whether two themes name the same thing: they share at least two key words (one when the shorter theme has one), and at least half of the
 * shorter theme. Returns the shared count, 0 for no match.
 */
export function themeOverlap(a: readonly string[], b: readonly string[]): number {
  const other = new Set(b);
  const shared = a.filter(word => other.has(word)).length;
  const shorter = Math.min(a.length, b.length);
  return shorter > 0 && shared >= Math.min(2, shorter) && shared * 2 >= shorter ? shared : 0;
}

/** The entry a theme repeats, any status: the one sharing the most key words, the newest on a tie. */
export function matchCorrection(ledger: Ledger, theme: readonly string[]): Correction | undefined {
  let best: Correction | undefined;
  let bestShared = 0;
  for (const entry of ledger.corrections) {
    const shared = themeOverlap(theme, entry.theme);
    if (shared > 0 && shared >= bestShared) { best = entry; bestShared = shared; }
  }
  return best;
}

const sameWords = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
const nextId = (ledger: Ledger): string => `c${1 + Math.max(0, ...ledger.corrections.map(entry => Number(entry.id.slice(1)) || 0))}`;

/**
 * Applies one call to the ledger in place. The same verbatim words again (a retried call, a second backfill) change nothing. A theme that
 * matches an entry records a repeat on it and reopens it; otherwise a new active entry.
 */
export function applyCorrection(ledger: Ledger, call: CorrectionCall, chat: ChatRef, at: string): CorrectionOutcome {
  if (call.kind === "fix") {
    const entry = ledger.corrections.find(item => item.id === call.fix.id);
    if (!entry) throw new Error(`No correction ${call.fix.id}`);
    if (call.fix.enforcedBy) entry.enforcedBy = call.fix.enforcedBy;
    if (call.fix.ref) entry.ref = call.fix.ref;
    if (call.fix.status) entry.status = call.fix.status;
    if (call.fix.handoff) entry.handoff = call.fix.handoff;
    return { kind: "fixed", entry };
  }
  const { input } = call;
  const known = ledger.corrections.find(entry => sameWords(entry.words, input.words) || entry.repeats.some(repeat => sameWords(repeat.words, input.words)));
  if (known) return { kind: "known", entry: known };
  const earlier = matchCorrection(ledger, input.theme);
  if (earlier) {
    const repeat = { at, chat, words: input.words };
    earlier.repeats.push(repeat);
    earlier.status = "reopened";
    if (input.handoff && !earlier.handoff) earlier.handoff = input.handoff;
    return { kind: "repeat", entry: earlier, repeat };
  }
  const entry: Correction = { id: nextId(ledger), at, chat, words: input.words, rule: input.rule, enforcedBy: input.enforcedBy, ref: input.ref,
    status: "active", theme: input.theme, repeats: [], ...(input.handoff ? { handoff: input.handoff } : {}) };
  ledger.corrections.push(entry);
  return { kind: "added", entry };
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
  return { to: text(record.to, "handoff.to"), topics };
}

/**
 * The tool's arguments: `id` marks a fix (enforcedBy, ref, status, handoff), else a new correction (words, rule, theme, enforcedBy, ref, and an
 * optional handoff). A fix that names enforcedBy or ref and no status sets the entry active: the fix landed.
 */
export function parseCorrectionCall(value: unknown): CorrectionCall {
  const input = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const handoff = input.handoff === undefined ? {} : { handoff: parseHandoff(input.handoff) };
  if (input.id !== undefined) {
    const id = text(input.id, "id");
    if (!/^c\d+$/.test(id)) throw new Error(`id is a correction id like c3, not ${id}`);
    const landed = input.enforcedBy !== undefined || input.ref !== undefined;
    const status = input.status !== undefined ? oneOf(input.status, CORRECTION_STATUSES, "status") : landed ? "active" : undefined;
    if (!status && !landed && input.handoff === undefined) throw new Error("a fix gives enforcedBy, ref, status or handoff");
    return { kind: "fix", fix: { id, ...(status ? { status } : {}),
      ...(input.enforcedBy === undefined ? {} : { enforcedBy: oneOf(input.enforcedBy, ENFORCEMENTS, "enforcedBy") }),
      ...(input.ref === undefined ? {} : { ref: text(input.ref, "ref") }), ...handoff } };
  }
  const theme = themeTokens(Array.isArray(input.theme) ? input.theme.filter((word): word is string => typeof word === "string") : text(input.theme, "theme"));
  if (!theme.length) throw new Error("theme needs key words");
  return { kind: "add", input: { words: text(input.words, "words"), rule: text(input.rule, "rule").replace(/\s+/g, " "), theme,
    enforcedBy: oneOf(input.enforcedBy, ENFORCEMENTS, "enforcedBy"), ref: text(input.ref, "ref"), ...handoff } };
}

/** What the tool tells the chat. A repeat says it is a sev and that the fix must be code or a test. */
export function correctionResult(outcome: CorrectionOutcome): string {
  const { entry } = outcome;
  switch (outcome.kind) {
    case "added": return `Recorded ${entry.id}: ${entry.rule} (enforced by ${entry.enforcedBy}: ${entry.ref}). Every chat reads it from its next model call.`;
    case "known": return `Already recorded as ${entry.id}: ${entry.rule}. Nothing changed.`;
    case "fixed": return `Updated ${entry.id}: enforced by ${entry.enforcedBy} (${entry.ref}), ${entry.status}` +
      `${entry.handoff ? `; steps on ${entry.handoff.topics.join(", ")} go to ${entry.handoff.to}` : ""}.`;
    case "repeat": return `Repeat of ${entry.id} "${entry.rule}", first given ${entry.at.slice(0, 10)} in ${entry.chat.name || entry.chat.id}; ` +
      `the owner has now repeated it ${entry.repeats.length} time${entry.repeats.length === 1 ? "" : "s"}, so ${entry.id} is reopened. ` +
      `A repeat is a sev: the earlier fix (${entry.enforcedBy}: ${entry.ref}) did not hold. Fix it in code or a test, not only more prompt text: ` +
      `start a job for it now, and when the fix lands call ${CORRECTION_TOOL} with id "${entry.id}", enforcedBy "code" or "test" and the ref.`;
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
  constructor(dataDir: string) { this.file = { path: join(dataDir, CORRECTIONS_FILE), label: "Corrections ledger", parse: parseLedger, initial: () => ({ corrections: [] }) }; }
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
/**
 * The text every chat reads before each model call: the active and reopened rules, reopened first, then newest first, one line each, at most
 * LEDGER_PROMPT_LINES. Null with no rule in force.
 */
export function ledgerPrompt(ledger: Ledger): string | null {
  const live = ledger.corrections.filter(entry => entry.status !== "retired")
    .sort((a, b) => Number(b.status === "reopened") - Number(a.status === "reopened") || lastAt(b).localeCompare(lastAt(a)));
  if (!live.length) return null;
  const lines = live.slice(0, LEDGER_PROMPT_LINES).map(entry =>
    `- ${entry.id}${entry.status === "reopened" ? ` (reopened: the owner repeated it ${entry.repeats.length}x; fix it in code or a test)` : ""} ${entry.rule}` +
    (entry.handoff ? ` Steps on ${entry.handoff.topics.join(", ")} belong to ${entry.handoff.to}.` : ""));
  const more = live.length - lines.length;
  return [`[corrections] The owner's corrections, live from the ledger. Each one holds in this chat now; the owner must never give one twice. ` +
    `Record a new correction with ${CORRECTION_TOOL} in the same turn.`, ...lines, ...(more > 0 ? [`and ${more} older ones in ${CORRECTIONS_FILE}`] : [])].join("\n");
}

/** Every repeat in [since, until], oldest first, with its entry: the Chat health repeat_corrections count. */
export function repeatsBetween(ledger: Ledger, since: number, until: number): { entry: Correction; repeat: CorrectionRepeat }[] {
  return ledger.corrections.flatMap(entry => entry.repeats.map(repeat => ({ entry, repeat })))
    .filter(({ repeat }) => { const at = Date.parse(repeat.at); return at >= since && at <= until; })
    .sort((a, b) => a.repeat.at.localeCompare(b.repeat.at));
}

/** A handoff in force: the correction that set it (not retired), the thread that owns the work, and its topics. */
export interface HandoffRule extends Handoff { correction: string }
export const handoffRules = (ledger: Ledger): HandoffRule[] =>
  ledger.corrections.flatMap(entry => entry.status !== "retired" && entry.handoff ? [{ correction: entry.id, to: entry.handoff.to, topics: entry.handoff.topics }] : []);
