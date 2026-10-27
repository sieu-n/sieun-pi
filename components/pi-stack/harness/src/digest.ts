import { createHash } from "node:crypto";
import { KINDS, type HarnessEntry, type HarnessState, type RefinementEvent } from "./store.ts";

/**
 * The `# Continual Harness State` digest, rebuilt from Prime 0.9.8's host (`qFn`, `jFn`, `JFn`, `GFn`) so readers of digest lines and
 * of `[harness-digest update]` deltas see the same text they see from Prime today.
 */

export const MAX_ENTRIES_PER_KIND = 6;
export const MAX_REFINEMENTS = 5;
export const MAX_CONTENT = 180;
const FINGERPRINT_VERSION = 1;

export const DIGEST_HEADER = "[harness-digest]\n\nThe persistent memories produced across this session so far:\n\n<harness_state>\n";
export const DIGEST_FOOTER = "\n</harness_state>";
export const UPDATE_HEADER =
  "[harness-digest update]\n\nThe continual harness changed after the harness digest above. A line here replaces any earlier digest line with the same id, and a removed entry no longer applies.\n\n<harness_update>\n";
export const UPDATE_FOOTER = "\n</harness_update>";

export interface DigestOptions {
  includeIpythonExamples?: boolean;
  includeShellExamples?: boolean;
  includeRefineExamples?: boolean;
  queryTerms?: Map<string, number>;
  maxEntriesPerKind?: number;
  maxRefinements?: number;
  maxContentLength?: number;
}

const REFINE_CALL_NOTE =
  "When to call `await refine.run()`: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep `await refine.run()` continual harness edits small and evidence-backed.";
const REFINE_NOTE =
  "When to refine the continual harness: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep continual harness edits small and evidence-backed.";
const CALL_CONTRACT_PYTHON =
  "Call contract: read each installed Python skill's SKILL.md and call its documented module function in the Python REPL; do not assume a `.run` entrypoint. Use `<skill_import> ...` in shell when a CLI exists. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Spawn a continual harness subagent spec by composing a concise task prompt and calling `handle = await rlm.spawn('sub-task', name='worker')`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role='parent')`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role='child', receiver_name=handle.name)` for follow-ups. Do not invent wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries.";
const CALL_CONTRACT_SHELL =
  "Call contract: use installed skills as shell commands when available (for example `<skill_import> ...`). Continual harness entries are routing/context hints only in sessions without the Python REPL; do not use Python `await`, `asyncio`, or `rlm` examples unless the prompt also documents a Python kernel.";
const CALL_CONTRACT_NONE =
  "Call contract: continual harness entries are routing/context hints only in sessions without the Python REPL or shell access; do not use Python `await`, `asyncio`, `rlm`, or shell skill commands unless the prompt also documents those interfaces.";

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3))}...`;
}

export function malformedEntry(entry: Partial<HarnessEntry>): string | undefined {
  if (typeof entry.content !== "string") return "content not a string";
  if (typeof entry.title !== "string") return "title not a string";
  return undefined;
}

export function malformedEvent(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return "event not an object";
  const e = event as Record<string, unknown>;
  if (typeof e.id !== "string") return "id not a string";
  if (typeof e.trigger !== "string") return "trigger not a string";
  if (!Array.isArray(e.changes)) return "changes not an array";
  if (!e.changes.every(c => typeof c === "string")) return "changes contain a non-string";
  if (e.outcome !== undefined && typeof e.outcome !== "string") return "outcome not a string";
  return undefined;
}

function eventLabel(event: unknown): string {
  if (event === null) return "null";
  if (event === undefined) return "undefined";
  if (typeof event !== "object") return `a ${typeof event}`;
  if (Array.isArray(event)) return "an array";
  const id = (event as { id?: unknown }).id;
  return typeof id === "string" ? id : `a ${typeof id} id`;
}

const scopedId = (scope: string, id: string) => `${scope}:${id}`;

export function entryLine(entry: HarnessEntry, max = MAX_CONTENT): string {
  const bad = malformedEntry(entry);
  if (bad) return `harness: skipped malformed entry ${entry.id} (${bad})`;
  const args = entry.kind === "skill" && Object.keys(entry.arguments ?? {}).length > 0 ? ` args=${truncate(JSON.stringify(entry.arguments), max)}` : "";
  const ref = entry.kind === "skill" && Object.keys(entry.reference ?? {}).length > 0 ? ` ref=${truncate(JSON.stringify(entry.reference), max)}` : "";
  return `- [${scopedId(entry.scope ?? "global", entry.id)}] ${entry.title} (${entry.path}, v${entry.version})${ref}${args}: ${truncate(entry.content, max)}`;
}

export function refinementLine(event: RefinementEvent, max = MAX_CONTENT): string {
  const bad = malformedEvent(event);
  if (bad) return `harness: skipped malformed refinement event ${eventLabel(event)} (${bad})`;
  const changes = event.changes.length > 0 ? event.changes.join(", ") : "no applied edits";
  const outcome = event.outcome ? `; outcome: ${truncate(event.outcome, max)}` : "";
  return `- [${event.id}] ${truncate(event.trigger, max)}: ${changes}${outcome}`;
}

const CJK = "\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}\u{2CEB0}-\u{2EBEF}\u{2EBF0}-\u{2EE5F}\u{2F800}-\u{2FA1F}\u{30000}-\u{3134F}\u{31350}-\u{323AF}\u{323B0}-\u{3347F}";
const CJK_CHAR = new RegExp(`[${CJK}]`, "u");
const CJK_SPLIT = new RegExp(`[${CJK}]+|[^${CJK}]+`, "gu");

/** Prime's `GFn`: words of 4+ characters, and CJK runs as bigrams, from mined conversation text. */
export function queryTermsOf(text: string): string[] {
  const out: string[] = [];
  for (const run of text.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? []) {
    for (const part of run.match(CJK_SPLIT) ?? []) {
      if (CJK_CHAR.test(part)) {
        const chars = Array.from(part);
        if (chars.length === 1) out.push(part);
        else for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
      } else if (part.length >= 4) out.push(part);
    }
  }
  return [...new Set(out)];
}

/** Prime's `_buildHarnessDigestQueryTerms`: up to 48 terms from the goal (weight 3) and the last 4 user and assistant texts (2, 1.5, 1, 1). */
export function buildQueryTerms(goal: string | undefined, recentTexts: string[]): Map<string, number> {
  const terms = new Map<string, number>();
  const add = (text: string | undefined, weight: number) => {
    if (!text) return;
    for (const term of queryTermsOf(text)) {
      if (terms.size >= 48 && !terms.has(term)) return;
      if (!terms.has(term)) terms.set(term, weight);
    }
  };
  add(goal, 3);
  let weight = 2;
  for (const text of recentTexts.slice(-4).reverse()) {
    add(text, weight);
    weight = Math.max(1, weight - 0.5);
  }
  return terms;
}

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");

function idfOf(entries: HarnessEntry[], terms: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (terms.size === 0) return out;
  const counts = new Map<string, number>();
  for (const e of entries) {
    const title = lower(e.title), content = lower(e.content), pathId = `${lower(e.path)} ${lower(e.id)}`;
    for (const term of terms.keys()) if (title.includes(term) || content.includes(term) || pathId.includes(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  for (const [term, count] of counts) out.set(term, Math.log(1 + entries.length / count));
  return out;
}

function score(e: HarnessEntry, terms: Map<string, number>, idf: Map<string, number>): number {
  if (terms.size === 0) return 0;
  const title = lower(e.title), content = lower(e.content), pathId = `${lower(e.path)} ${lower(e.id)}`;
  let total = 0;
  for (const [term, weight] of terms) {
    const fields = (title.includes(term) ? 1 : 0) + (content.includes(term) ? 1 : 0) + (pathId.includes(term) ? 1 : 0);
    if (fields > 0) total += weight * (idf.get(term) ?? 1) * (1 + (fields - 1) * 0.5);
  }
  return total;
}

const sortKey = (e: HarnessEntry) => [e.path, e.title, e.id].join("\0");

/** Prime's `qFn`: the full digest text. */
export function buildDigest(state: HarnessState, options: DigestOptions = {}): string {
  const perKind = options.maxEntriesPerKind ?? MAX_ENTRIES_PER_KIND;
  const maxRefinements = options.maxRefinements ?? MAX_REFINEMENTS;
  const max = options.maxContentLength ?? MAX_CONTENT;
  const ipython = options.includeIpythonExamples ?? true;
  const lines = [
    "# Continual Harness State",
    "",
    "Local continual harness entries belong to this Prime Agent session. Global continual harness entries persist across Prime Agent sessions.",
    "The continual harness entries below are compact summaries, not full descriptions. Use them as routing/context hints; inspect or refine the underlying continual harness entry only when detail matters.",
    "Default to local continual harness refinement for current task progress, temporary blockers, and session coordination. Use global continual harness refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.",
    "Use these continual harness prompt notes, memories, skills, and subagent specs when they are relevant. The base system prompt is immutable; prompt entries below are supplemental notes only.",
    "",
    (options.includeRefineExamples ?? ipython) ? REFINE_CALL_NOTE : REFINE_NOTE,
    "",
    ipython ? CALL_CONTRACT_PYTHON : options.includeShellExamples ? CALL_CONTRACT_SHELL : CALL_CONTRACT_NONE,
    "",
  ];
  const terms = options.queryTerms;
  const ranked = terms !== undefined && terms.size > 0;
  let total = 0;
  for (const kind of Object.keys(state.entries) as (keyof HarnessState["entries"])[]) {
    const entries = Object.values(state.entries[kind]);
    const idf = ranked ? idfOf(entries, terms) : new Map<string, number>();
    entries.sort((a, b) => {
      if (ranked) {
        const diff = score(b, terms, idf) - score(a, terms, idf);
        if (diff !== 0) return diff;
      }
      return sortKey(a).localeCompare(sortKey(b));
    });
    total += entries.length;
    if (kind === "subagent" && entries.length > 0 && ipython)
      lines.push(`${kind}: ${entries.length} (invoke a spec by turning it into a concise task prompt and spawning with \`await rlm.spawn('<task>', name='<worker>')\`; admission returns a child handle, never the answer)`);
    else lines.push(`${kind}: ${entries.length}`);
    if (ranked && entries.length > perKind) lines.push("(entries ranked by relevance to the current task; see harness.search)");
    for (const e of entries.slice(0, perKind)) lines.push(entryLine(e, max));
    const more = entries.length - Math.min(entries.length, perKind);
    if (more > 0) lines.push(`- +${more} more ${kind} entries`);
    lines.push("");
  }
  if (total === 0) lines.push("No saved harness entries yet.", "");
  lines.push(`recent refinements: ${state.refinements.length}`);
  for (const event of state.refinements.slice(-maxRefinements)) lines.push(refinementLine(event, max));
  const older = state.refinements.length - Math.min(state.refinements.length, maxRefinements);
  if (older > 0) lines.push(`- +${older} older refinement events`);
  return lines.join("\n").trim();
}

/** Prime's `JFn`: a hash of everything the digest can show except the ranking terms, so a digest is resent only when the state changed. */
export function fingerprint(state: HarnessState, options: Omit<DigestOptions, "queryTerms"> = {}): string {
  const entries = KINDS.flatMap(kind => Object.values(state.entries[kind] ?? {}))
    .map(e => ({
      scope: e.scope ?? "global",
      kind: e.kind,
      id: e.id,
      title: e.title,
      path: e.path,
      version: e.version,
      content: e.content,
      reference: e.kind === "skill" ? e.reference : undefined,
      arguments: e.kind === "skill" ? e.arguments : undefined,
    }))
    .sort((a, b) => [a.scope, a.kind, a.id].join("\0").localeCompare([b.scope, b.kind, b.id].join("\0")));
  const refinements = state.refinements.map(r => {
    const bad = malformedEvent(r);
    return bad !== undefined ? { malformed: bad, label: eventLabel(r) } : { id: r.id, trigger: r.trigger, changes: r.changes, outcome: r.outcome };
  });
  const renderFlags = options.includeIpythonExamples ? { ...options, includeShellExamples: false } : options;
  return createHash("sha256").update(JSON.stringify({ version: FINGERPRINT_VERSION, renderFlags, entries, refinements })).digest("hex");
}

const LINE = /^- \[((?:global|local):[^\]]+)\] (.*)$/;
const REMOVED = /^- removed \[((?:global|local):[^\]]+)\]/;

function deliveredLines(texts: string[]): Map<string, string> {
  const lines = new Map<string, string>();
  for (const text of texts)
    for (const line of text.split("\n")) {
      const removed = REMOVED.exec(line);
      if (removed) {
        lines.delete(removed[1]);
        continue;
      }
      const match = LINE.exec(line);
      if (match) lines.set(match[1], line);
    }
  return lines;
}

const after = (stamp: unknown, since: number) => {
  const t = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(t) && t >= since;
};

/**
 * Prime's `jFn`: the `[harness-digest update]` body, or undefined when nothing changed.
 * `delivered` are the digest and update texts already in context, oldest first, and `since` is the time of the last one.
 */
export function buildDelta(state: HarnessState, delivered: string[], since: number, options: DigestOptions = {}): string | undefined {
  const perKind = options.maxEntriesPerKind ?? MAX_ENTRIES_PER_KIND;
  const maxRefinements = options.maxRefinements ?? MAX_REFINEMENTS;
  const max = options.maxContentLength ?? MAX_CONTENT;
  const known = deliveredLines(delivered);
  const kinds = Object.keys(state.entries) as (keyof HarnessState["entries"])[];
  const seen = new Set<string>();
  const changed: string[] = [];
  for (const kind of kinds) {
    const fresh = Object.values(state.entries[kind])
      .filter(e => {
        const id = scopedId(e.scope ?? "global", e.id);
        seen.add(id);
        const before = known.get(id);
        return before !== undefined ? before !== entryLine(e, max) : after(e.updated_at, since);
      })
      .sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) || sortKey(a).localeCompare(sortKey(b)));
    for (const e of fresh.slice(0, perKind)) changed.push(entryLine(e, max));
    if (fresh.length > perKind) changed.push(`- +${fresh.length - perKind} more changed ${kind} entries`);
  }
  const removed: string[] = [];
  for (const [id, line] of known) {
    if (seen.has(id)) continue;
    const title = LINE.exec(line)?.[2].replace(/ \([^()]*, v\d+\).*$/, "");
    removed.push(`- removed [${id}]${title ? ` ${title}` : ""}. Stop following it.`);
  }
  const events = state.refinements.filter(r => malformedEvent(r) === undefined && after(r.created_at, since));
  if (changed.length === 0 && removed.length === 0 && events.length === 0) return undefined;
  const out: string[] = [];
  if (changed.length > 0) out.push("Added or changed:", ...changed, "");
  if (removed.length > 0) out.push("Removed:", ...removed, "");
  if (events.length > 0) {
    out.push("New refinements:");
    for (const e of events.slice(-maxRefinements)) out.push(refinementLine(e, max));
    if (events.length > maxRefinements) out.push(`- +${events.length - maxRefinements} more new refinement events`);
    out.push("");
  }
  const totals = kinds.map(kind => `${kind} ${Object.keys(state.entries[kind]).length}`);
  out.push(`Totals now: ${[...totals, `refinements ${state.refinements.length}`].join(", ")}.`);
  return out.join("\n");
}

/** Prime's `VFn`: the state as the planner and the review gate see it, 40 entries per kind and 240 characters each. */
export function plannerOverview(state: HarnessState): string {
  const lines: string[] = [];
  for (const kind of Object.keys(state.entries) as (keyof HarnessState["entries"])[]) {
    const entries = Object.values(state.entries[kind]);
    lines.push(`${kind}: ${entries.length}`);
    for (const e of entries.slice(0, 40)) {
      const bad = malformedEntry(e);
      if (bad) {
        lines.push(`- harness: skipped malformed entry ${e.id} (${bad})`);
        continue;
      }
      const content = e.content.replace(/\s+/g, " ").slice(0, 240);
      const args = e.kind === "skill" && Object.keys(e.arguments).length > 0 ? ` args=${JSON.stringify(e.arguments).slice(0, 240)}` : "";
      const ref = e.kind === "skill" && Object.keys(e.reference).length > 0 ? ` ref=${JSON.stringify(e.reference).slice(0, 240)}` : "";
      lines.push(`- [${e.scope ?? "global"}:${e.id}] ${e.title} (${e.path}, v${e.version})${ref}${args}: ${content}`);
    }
    if (entries.length > 40) lines.push(`- +${entries.length - 40} more ${kind} entries`);
  }
  return lines.join("\n");
}

export const digestMessageContent = (digest: string) => DIGEST_HEADER + digest + DIGEST_FOOTER;
export const updateMessageContent = (delta: string) => UPDATE_HEADER + delta + UPDATE_FOOTER;
