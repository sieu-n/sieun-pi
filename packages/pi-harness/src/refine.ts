import { KINDS, type HarnessEntry, type HarnessState, type Kind, type Scope } from "./store.ts";
import { plannerOverview, truncate, malformedEntry, MAX_CONTENT } from "./digest.ts";
import { PLANNER_PROMPT, REVIEW_PROMPT } from "./prompts.ts";

/**
 * One refine, rebuilt from Prime 0.9.8's host: the planner and review calls' prompts, parsing and validation of the planner's JSON edits,
 * applying them to a store with before and after snapshots, rollback proposals and the notice texts.
 */

export type EditAction = "create" | "update" | "delete";

export interface RefineEdit {
  action: EditAction;
  kind: Kind;
  id?: string;
  title?: string;
  content?: string;
  path?: string;
  reference?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  reason?: string;
}

export interface RefineProposal {
  summary: string;
  rationale: string;
  expectedOutcome: string;
  edits: RefineEdit[];
}

export interface AppliedEdit extends RefineEdit {
  id: string;
  applied: boolean;
  error?: string;
  before?: HarnessEntry;
  after?: HarnessEntry;
}

/** One refine record, the shape Prime keeps in `prime-agent.refinement` session entries and `refinements.jsonl`. */
export interface RefineResult {
  id: string;
  summary: string;
  rationale: string;
  expectedOutcome: string;
  appliedEdits: AppliedEdit[];
  harnessStatePath: string;
  rollbackOf?: string;
  scope?: Scope;
}

export interface ReviewDecision {
  shouldRefine: boolean;
  rationale: string;
  instructions?: string;
}

export type RefineSource = "auto" | "user" | "self";

export interface RefineArgs {
  instructions?: string;
  rollbackId?: string;
  global: boolean;
}

export const REFINEMENT_ENTRY = "prime-agent.refinement";
export const NOTICE_TYPE = "refinement_notice";
export const OUTCOME_TYPE = "refinement_outcome";
const TRUNCATED_JSON =
  "the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const now = () => new Date().toISOString();

/** Prime's refine ids: `refine_` and the UTC time to the millisecond. */
export const newRefineId = () => `refine_${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;

function slug(raw: string | undefined, fallback: string): string {
  return (typeof raw === "string" ? raw : fallback).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || fallback;
}

/** Prime's `iUn`: `/refine [--global] [instructions]` and `/refine rollback <id> [--global]`. */
export function parseRefineArgs(text: string): RefineArgs {
  let rest = text.trim();
  let global = false;
  if (/^--global(?=\s|$)/.test(rest)) {
    global = true;
    rest = rest.replace(/^--global(?=\s|$)/, "").trim();
  }
  if (rest === "rollback") throw new Error("Usage: /refine rollback <refinement-id>");
  const rollback = /^rollback[\t\p{Zs}]/u.exec(rest);
  if (rollback) {
    let id = rest.slice(rollback[0].length).trim();
    if (id === "--global") throw new Error("Usage: /refine rollback <refinement-id>");
    if (/\s--global$/.test(id)) {
      global = true;
      id = id.replace(/\s--global$/, "").trim();
    }
    if (!id) throw new Error("Usage: /refine rollback <refinement-id>");
    return { rollbackId: id, global };
  }
  return { instructions: rest || undefined, global };
}

function unfinishedJson(text: string): boolean {
  let depth = 0, inString = false, escaped = false;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return inString || depth > 0;
}

function parseStrict(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (unfinishedJson(text)) throw new Error(TRUNCATED_JSON);
    throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Prime's `ZFn`: the JSON object in a model reply, bare, fenced or embedded in prose. */
export function extractJson(reply: string): unknown {
  const text = reply.trim();
  if (text.startsWith("{") && text.endsWith("}")) return parseStrict(text);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return parseStrict(fenced[1].trim());
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return parseStrict(text.slice(start));
    }
  }
  if (unfinishedJson(text)) throw new Error(TRUNCATED_JSON);
  throw new Error("Refiner did not return a JSON object");
}

/** Prime's `Cet`: a planner reply as a proposal, keeping only fields of the right type. */
export function normalizeProposal(value: unknown): RefineProposal {
  const v = record(value) ?? {};
  const edits = Array.isArray(v.edits) ? v.edits : [];
  return {
    summary: typeof v.summary === "string" ? v.summary : "Refined continual harness state",
    rationale: typeof v.rationale === "string" ? v.rationale : "",
    expectedOutcome: typeof v.expectedOutcome === "string" ? v.expectedOutcome : "",
    edits: edits.filter(e => typeof e === "object" && e !== null).map(raw => {
      const e = raw as Record<string, unknown>;
      return {
        action: e.action as EditAction,
        kind: e.kind as Kind,
        id: typeof e.id === "string" ? e.id : undefined,
        title: typeof e.title === "string" ? e.title : undefined,
        content: typeof e.content === "string" ? e.content : undefined,
        path: typeof e.path === "string" ? e.path : undefined,
        reference: record(e.reference),
        arguments: record(e.arguments),
        metadata: record(e.metadata),
        reason: typeof e.reason === "string" ? e.reason : undefined,
      };
    }),
  };
}

export function parseProposal(reply: string): RefineProposal {
  const value = extractJson(reply);
  if (!record(value)) throw new Error("Refiner JSON must be an object");
  return normalizeProposal(value);
}

export function parseReview(reply: string): ReviewDecision {
  const value = record(extractJson(reply));
  if (!value) throw new Error("Auto-refine review JSON must be an object");
  return {
    shouldRefine: value.shouldRefine === true,
    rationale: typeof value.rationale === "string" ? value.rationale : "No rationale provided.",
    instructions: typeof value.instructions === "string" ? value.instructions : undefined,
  };
}

/** Prime's `gZs`: why an edit cannot apply, or undefined when it can. */
export function invalidEdit(edit: RefineEdit, id: string): string | undefined {
  if (!["create", "update", "delete"].includes(edit.action)) return `unsupported action ${String(edit.action)}`;
  if (!(KINDS as readonly string[]).includes(edit.kind)) return `unsupported kind ${String(edit.kind)}`;
  if (edit.kind === "prompt" && (edit.id === "base_system_prompt" || id === "base_system_prompt")) return "base system prompt is not editable";
  if (edit.action !== "create" && !edit.id) return `${edit.action} requires id`;
  if (edit.action !== "delete" && (!edit.title || !edit.content)) return `${edit.action} requires title and content`;
  if (edit.id !== undefined && (typeof edit.id !== "string" || edit.id.length === 0)) return `${edit.action} requires id to be a non-empty string when provided`;
  if (edit.path !== undefined && (typeof edit.path !== "string" || edit.path.length === 0)) return `${edit.action} requires path to be a non-empty string when provided`;
  if (edit.action !== "delete" && edit.kind === "skill") {
    if (edit.arguments === undefined) return `${edit.action} skill requires arguments`;
    const ref = edit.reference;
    if (!ref) return `${edit.action} skill requires python reference`;
    if (ref.type !== "python") return `${edit.action} skill reference.type must be python`;
    const hasImport = (typeof ref.import === "string" && ref.import.length > 0) || (typeof ref.python_import === "string" && ref.python_import.length > 0);
    const hasCall = (typeof ref.callable === "string" && ref.callable.length > 0) || (typeof ref.call_pattern === "string" && ref.call_pattern.length > 0);
    if (!hasImport) return `${edit.action} skill requires python import`;
    if (!hasCall) return `${edit.action} skill requires callable or call_pattern`;
  }
  return undefined;
}

const stripScope = (id: string | undefined) => (id?.startsWith("local:") ? id.slice(6) : id?.startsWith("global:") ? id.slice(7) : id);

export interface ApplyOptions {
  id: string;
  scope: Scope;
  rollbackOf?: string;
  /** The target store as the planner saw it. An entry that changed since then is left alone. */
  baseline?: HarnessState;
}

/** Prime's `eUn`: applies a proposal to `state` in place, records one refinement event, and returns the refine record. */
export function applyProposal(state: HarnessState, proposal: RefineProposal, options: ApplyOptions): RefineResult {
  const results: AppliedEdit[] = [];
  const touched = new Set<string>();
  for (const raw of proposal.edits) {
    const edit = { ...raw, id: stripScope(raw.id) };
    const id = edit.id ?? (edit.action === "create" ? slug(edit.title ?? edit.kind, edit.kind) : undefined) ?? "";
    const problem = invalidEdit(edit, id);
    if (problem) {
      results.push({ ...edit, id, applied: false, error: problem });
      continue;
    }
    const store = state.entries[edit.kind];
    const before = clone(store[id]);
    const key = `${edit.kind}:${id}`;
    if (options.baseline && !touched.has(key) && JSON.stringify(before) !== JSON.stringify(clone(options.baseline.entries[edit.kind][id]))) {
      results.push({ ...edit, id, before, applied: false, error: "entry changed during refinement planning" });
      continue;
    }
    if (edit.action === "delete") {
      if (!before) {
        results.push({ ...edit, id, applied: false, error: "entry not found" });
        continue;
      }
      delete store[id];
      touched.add(key);
      results.push({ ...edit, id, before, applied: true });
      continue;
    }
    if (edit.action === "create" && before) {
      results.push({ ...edit, id, before, applied: false, error: "entry already exists" });
      continue;
    }
    if (edit.action === "update" && !before) {
      results.push({ ...edit, id, applied: false, error: "entry not found" });
      continue;
    }
    const entry: HarnessEntry = {
      id,
      kind: edit.kind,
      title: edit.title ?? before?.title ?? id,
      content: edit.content ?? before?.content ?? "",
      path: edit.path ?? before?.path ?? "general",
      scope: before?.scope ?? options.scope ?? "local",
      reference: edit.reference ?? before?.reference ?? {},
      arguments: edit.arguments ?? before?.arguments ?? {},
      metadata: edit.metadata ?? before?.metadata ?? {},
      source: "refine",
      created_at: before?.created_at ?? now(),
      updated_at: now(),
      version: before ? before.version + 1 : 1,
    };
    store[id] = entry;
    touched.add(key);
    results.push({ ...edit, id, before, after: clone(entry), applied: true });
  }
  const changes = results.filter(r => r.applied).map(r => `${r.action} ${r.kind}:${r.id}`);
  state.refinements.push({ id: options.id, trigger: proposal.summary, changes, evidence: proposal.rationale, outcome: proposal.expectedOutcome, created_at: now() });
  return {
    id: options.id,
    summary: proposal.summary,
    rationale: proposal.rationale,
    expectedOutcome: proposal.expectedOutcome,
    appliedEdits: results,
    harnessStatePath: "",
    rollbackOf: options.rollbackOf,
    scope: options.scope,
  };
}

/** Prime's `IZs`: the edits that undo one refine, newest edit first. */
export function rollbackProposal(record: RefineResult): RefineProposal {
  const edits: RefineEdit[] = [];
  for (const e of [...record.appliedEdits].reverse()) {
    if (!e.applied) continue;
    if (e.before)
      edits.push({
        action: e.after ? "update" : "create",
        kind: e.kind,
        id: e.id,
        title: e.before.title,
        content: e.before.content,
        path: e.before.path ?? (e.before as { topic?: string }).topic,
        reference: e.before.reference,
        arguments: e.before.arguments,
        metadata: e.before.metadata,
        reason: `Rollback ${record.id}`,
      });
    else if (e.after) edits.push({ action: "delete", kind: e.kind, id: e.id, reason: `Rollback ${record.id}` });
  }
  return {
    summary: `Rollback refinement ${record.id}`,
    rationale: `Restores continual harness state snapshots from refinement ${record.id}.`,
    expectedOutcome: "Faulty refinement edits are reverted.",
    edits,
  };
}

/** Prime's `WIe`: the scope a refine record wrote to. */
export function recordScope(record: RefineResult): Scope | undefined {
  if (record.scope) return record.scope;
  const scopes = new Set<Scope>();
  for (const e of record.appliedEdits) {
    const s = e.after?.scope ?? e.before?.scope;
    if (s) scopes.add(s);
  }
  return scopes.size === 1 ? [...scopes][0] : undefined;
}

/** Prime's `UFn`: the notice body, the summary and one line per applied edit. */
export function noticeBody(record: RefineResult): string {
  const lines = [truncate(record.summary, MAX_CONTENT)];
  for (const e of record.appliedEdits) {
    if (!e.applied) continue;
    const entry = e.after ?? e.before;
    const scope = entry?.scope ?? record.scope ?? "local";
    const bad = entry ? malformedEntry(entry) : undefined;
    lines.push(`- ${e.action} ${e.kind} [${scope}:${e.id}] ${bad ? e.id : (entry?.title ?? e.id)}: ${truncate(bad ? "" : (entry?.content ?? ""), MAX_CONTENT)}${bad ? ` (skipped malformed entry: ${bad})` : ""}`);
  }
  return lines.join("\n");
}

export const noticeContent = (record: RefineResult, source: RefineSource) => `[${source}-refinement]\n\n${noticeBody(record)}`;

export function noticeDetails(record: RefineResult, source: RefineSource) {
  return { refinementId: record.id, summary: record.summary, scope: record.scope ?? "local", ...(record.rollbackOf ? { rollbackOf: record.rollbackOf } : {}), edits: record.appliedEdits, source };
}

export const outcomeContent = (record: RefineResult) => `Refinement complete: ${record.summary}`;

export function outcomeDetails(record: RefineResult) {
  return { refinementId: record.id, summary: record.summary, scope: record.scope ?? "local", ...(record.rollbackOf ? { rollbackOf: record.rollbackOf } : {}), edits: record.appliedEdits };
}

/** Prime's `YFn`: the last 20 refines as the planner sees them. */
export function historyText(history: RefineResult[]): string {
  if (history.length === 0) return "No prior refinement history.";
  return history
    .slice(-20)
    .map(r => {
      const edits = r.appliedEdits.map(e => `${e.applied ? "applied" : "failed"} ${e.action} ${e.kind}:${e.id}`).join(", ");
      return `[${r.id}]${r.rollbackOf ? ` rollbackOf=${r.rollbackOf}` : ""} ${r.summary}\n${edits}\nExpected outcome: ${r.expectedOutcome}`;
    })
    .join("\n\n");
}

/** Prime's `OFn`: one history from the global log and this session's records, later records replacing earlier ones by id. */
export function mergeHistory(global: RefineResult[], session: RefineResult[]): RefineResult[] {
  const byId = new Map<string, RefineResult>();
  for (const r of global) byId.set(r.id, { ...r, scope: recordScope(r) ?? "global" });
  for (const r of session) {
    const old = byId.get(r.id);
    byId.set(r.id, r.scope || !old?.scope ? r : { ...r, scope: old.scope });
  }
  return [...byId.values()];
}

const GLOBAL_POLICY =
  "Requested refinement scope: global. Only propose stable cross-session continual harness edits, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts that should affect future Prime Agent sessions. Do not persist session-only progress, temporary blockers, or current-run coordination globally.";
const LOCAL_POLICY =
  "Requested refinement scope: local. Prefer local continual harness edits for current task progress, temporary blockers, current-run coordination, and project facts that are not clearly reusable across Prime Agent sessions. Global entries in the overview are read-only context: do not propose update or delete edits for them; create a local entry instead if an override is needed.";

/** The planner's user prompt for one conversation text. */
export function plannerPrompt(state: HarnessState, history: RefineResult[], conversation: string, args: { global: boolean; instructions?: string }): string {
  return [
    `<current_harness_state>\n${plannerOverview(state)}\n</current_harness_state>`,
    `<refinement_history>\n${historyText(history)}\n</refinement_history>`,
    `<conversation>\n${conversation}\n</conversation>`,
    `<scope_policy>\n${args.global ? GLOBAL_POLICY : LOCAL_POLICY}\n</scope_policy>`,
    args.instructions ? `<user_refine_instructions>\n${args.instructions}\n</user_refine_instructions>` : "",
    "Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type AutoReason = "turn_interval" | "compact";

/** The review gate's user prompt for one conversation text. */
export function reviewPrompt(state: HarnessState, history: RefineResult[], conversation: string, trigger: { reason: AutoReason; turnsSinceLastReview: number }): string {
  return [
    `<trigger>\n${trigger.reason}; ${trigger.turnsSinceLastReview} assistant turns since last auto-refine review\n</trigger>`,
    `<current_harness_state>\n${plannerOverview(state)}\n</current_harness_state>`,
    `<refinement_history>\n${historyText(history)}\n</refinement_history>`,
    `<conversation>\n${conversation}\n</conversation>`,
    "Return shouldRefine=true when the trajectory contains evidence useful to this session's future turns. Prefer local harness edits for current task progress, temporary blockers, and current-run coordination. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified facts likely to be reused in future sessions.",
  ].join("\n\n");
}

/** Prime's `gmt`: the planner instructions after the review gate said yes. */
export function autoRefineInstructions(reason: AutoReason, review: ReviewDecision): string {
  const extra = review.instructions ? `\nReviewer instructions: ${review.instructions}` : "";
  return `Automatic refine review triggered by ${reason}. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: ${review.rationale}${extra}`;
}

export { PLANNER_PROMPT, REVIEW_PROMPT };
