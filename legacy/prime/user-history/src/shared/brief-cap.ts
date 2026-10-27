import type { FlaggedSlice } from "./chat-duties.ts";

/**
 * How many flagged items a duty or check-in job's brief, a check-in job's report, and each notice the chat server sends a chat about duties
 * and check-ins list. The rest stay in a detail file the text names. The owner on 10-15, on a check-in brief that listed about 150 flagged
 * step ids: "i hope this doesn't go in the prompt by the way. it's not helpful at all."
 */
export const BRIEF_ITEMS = 3;

/** The first BRIEF_ITEMS lines as bullets, then one line that counts the rest and names the file that holds them all. */
export function cappedLines(lines: readonly string[], detail?: string): string {
  const shown = lines.slice(0, BRIEF_ITEMS).map(line => `- ${line}`);
  const rest = lines.length - shown.length;
  return [...shown, ...rest > 0 ? [`- and ${rest} more${detail ? `, all listed in ${detail}` : ""}`] : []].join("\n");
}

/** Kinds that break a hard rule (c49, the go and requirements gates): they lead the shown items whatever the headline is. */
const RULE_KINDS = new Set(["merges_without_go", "go_missing", "requirements_missing"]);
const MAX_CHARS = 240;

/** A flagged item as a sentence a person reads: its excerpt, with its id when the excerpt does not name it, and no kind label. */
export function plainItem(slice: Pick<FlaggedSlice, "excerpt" | "item">): string {
  const text = slice.excerpt.replace(/\s+/g, " ").trim();
  const clipped = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1).trimEnd()}\u2026` : text;
  return slice.item && !clipped.includes(slice.item) ? `${clipped} (${slice.item})` : clipped;
}

/** The flagged items in the order a brief shows them: hard-rule breaches, then the headline metric's items, then the rest as flagged. */
export function briefOrder(flagged: readonly FlaggedSlice[], headlineKey?: string): FlaggedSlice[] {
  const rank = (slice: FlaggedSlice): number => RULE_KINDS.has(slice.kind) ? 0 : slice.kind === headlineKey ? 1 : 2;
  return flagged.map((slice, at) => ({ slice, at })).sort((a, b) => rank(a.slice) - rank(b.slice) || a.at - b.at).map(({ slice }) => slice);
}

/** A metric's number for the brief's first line, like `stuck_steps at 10, target at most 0 (Open steps nobody is moving)`. */
export function headlineWords(metric: { key: string; label: string; op: "<=" | ">="; target: number; unit?: string }, value: number): string {
  const unit = metric.unit ?? "";
  return `${metric.key} at ${value}${unit}, target ${metric.op === "<=" ? "at most" : "at least"} ${metric.target}${unit} (${metric.label})`;
}

/**
 * The findings a duty or check-in job's brief carries: the headline number, at most BRIEF_ITEMS flagged items in plain words, and the detail
 * file that holds every flagged item and the full precheck. Never the full list.
 */
export function briefFindings({ headline, flagged, headlineKey, detail }: { headline: string | null; flagged: readonly FlaggedSlice[]; headlineKey?: string; detail: string }): string {
  const items = briefOrder(flagged, headlineKey).map(plainItem);
  const count = items.length === 1 ? "1 flagged item" : `${items.length} flagged items`;
  return [
    ...headline ? [`The headline number this run is ${headline}.`] : [],
    items.length ? `${count}; the first ${Math.min(items.length, BRIEF_ITEMS)}:\n${cappedLines(items)}` : "No flagged items.",
    `Every flagged item and the full precheck are in ${detail}. Read it for the items you work on; never paste the list into a message.`,
  ].join("\n\n");
}
