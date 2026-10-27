/**
 * The search box's text and filters as one typed query: Slack-style modifiers come out of the text, and what is left becomes FTS5 MATCH text
 * under the rewrite rules of search.md section 5 ("Ranking and filters"), measured there on the family index.
 */

export const KINDS = ["user", "assistant", "thinking", "tool_call", "tool_result", "agent_message", "notice", "summary"] as const;
export type Kind = typeof KINDS[number];

/** The kind groups `kind:` accepts besides an exact kind. */
const KIND_GROUPS: Record<string, readonly Kind[]> = {
  message: ["user", "assistant", "agent_message"],
  tool: ["tool_call", "tool_result"],
  agent: ["agent_message"],
  thinking: ["thinking"],
  summary: ["summary"],
};

export interface Filters {
  /** `in:`, `chat=`: a chat or thread name, or a session id prefix. Several values match any of them. */
  in: string[];
  /** `from:`, `agent=`: an agent name, `owner` or `tool`. */
  from: string[];
  /** Null searches every kind but thinking. */
  kinds: Kind[] | null;
  /** `box:`, `box=`: hosts.json names; empty asks every box. */
  boxes: string[];
  /** Entry time bounds in ms, `since` inclusive and `until` exclusive. */
  since?: number;
  until?: number;
  isError: boolean;
}

export interface Query {
  /** FTS5 MATCH text for the positive terms, null when the text names none. */
  match: string | null;
  /** The positive terms without the session id terms, for the branch that matches `files.session` instead (null: no other term). */
  rest: string | null;
  /** Session ids or 8-hex prefixes named bare in the text. */
  sessionIds: string[];
  /** MATCH text a hit must not match (`-word`), null when nothing is excluded. */
  exclude: string | null;
  filters: Filters;
  /** Thinking hits show only when asked for. */
  thinking: boolean;
}

export interface QueryParams {
  q?: string | null;
  kind?: string | null;
  box?: string | null;
  chat?: string | null;
  agent?: string | null;
  since?: string | null;
  until?: string | null;
}

export class QueryError extends Error {}

const DAY = 86_400_000;
const KST = 9 * 3_600_000;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const PUNCTUATED = /[-./_]/;
const SESSION_ID = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const OPERATORS = new Set(["AND", "OR", "NOT"]);
const MODIFIER = /^(-?)(in|from|kind|box|before|after|on|is):(.*)$/s;

/** Splits text into words, keeping a quoted run whole, also after a `key:`. Each word keeps its quotes. */
export function words(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') { quoted = !quoted; current += char; continue; }
    if (!quoted && /\s/.test(char)) { if (current) out.push(current); current = ""; continue; }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

const unquote = (word: string): string => word.replace(/^"/, "").replace(/"$/, "");
const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;

/** One term of the search text as FTS5 text: Hangul as a prefix term, a quoted string or a punctuated word as a phrase. */
export function ftsTerm(word: string): string | null {
  const phrase = word.startsWith('"');
  let text = phrase ? unquote(word) : word;
  const prefix = !phrase && text.length > 1 && text.endsWith("*");
  if (prefix) text = text.slice(0, -1);
  if (!phrase) text = text.replace(/^[()]+|[()]+$/g, "");
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  const hangul = !phrase && HANGUL.test(text) && !PUNCTUATED.test(text);
  return quote(text) + (prefix || hangul ? "*" : "");
}

/** A date bound in ms: YYYY-MM-DD is a KST day, anything else must parse as an ISO time. `end` gives the day's end for a date. */
export function parseDate(text: string, end = false): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const start = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) - KST;
    return end ? start + DAY : start;
  }
  const at = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || Number.isNaN(at)) throw new QueryError(`Not a date: ${text}. Use YYYY-MM-DD (KST) or an ISO time.`);
  return at;
}

const later = (a: number | undefined, b: number): number => a === undefined ? b : Math.max(a, b);
const earlier = (a: number | undefined, b: number): number => a === undefined ? b : Math.min(a, b);

function kindsOf(value: string): Kind[] {
  const group = KIND_GROUPS[value.toLowerCase()];
  if (group) return [...group];
  if ((KINDS as readonly string[]).includes(value)) return [value as Kind];
  throw new QueryError(`Unknown kind: ${value}. Use message, tool, agent, thinking, summary or one of ${KINDS.join(", ")}.`);
}

const list = (value: string | null | undefined): string[] => (value ?? "").split(",").map(part => part.trim()).filter(Boolean);

/** Parses the search text and the request's own filters into one query; both kinds of filter add up. */
export function parseQuery(params: QueryParams): Query {
  const filters: Filters = { in: list(params.chat), from: list(params.agent), kinds: null, boxes: list(params.box), isError: false };
  let kinds: Kind[] = list(params.kind).flatMap(kindsOf);
  if (params.since) filters.since = parseDate(params.since);
  if (params.until) filters.until = parseDate(params.until, true);
  const positive: string[] = [];
  const plain: string[] = [];
  const negative: string[] = [];
  const sessionIds: string[] = [];
  for (const word of words(params.q ?? "")) {
    const modifier = MODIFIER.exec(word);
    if (modifier && modifier[3] && !modifier[1]) {
      const [, , key, raw] = modifier;
      const value = unquote(raw!);
      if (key === "in") filters.in.push(value);
      else if (key === "from") filters.from.push(value);
      else if (key === "kind") kinds = [...kinds, ...kindsOf(value)];
      else if (key === "box") filters.boxes.push(value);
      else if (key === "before") filters.until = earlier(filters.until, parseDate(value));
      else if (key === "after") filters.since = later(filters.since, /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseDate(value, true) : parseDate(value) + 1);
      else if (key === "on") { filters.since = later(filters.since, parseDate(value)); filters.until = earlier(filters.until, parseDate(value, true)); }
      else if (key === "is" && value === "error") filters.isError = true;
      else throw new QueryError(`Unknown modifier ${key}:${value}.`);
      continue;
    }
    if (OPERATORS.has(word)) { positive.push(word); plain.push(word); continue; }
    if (word.length > 1 && word.startsWith("-")) {
      const term = ftsTerm(word.slice(1));
      if (term) negative.push(term);
      continue;
    }
    const term = ftsTerm(word);
    if (!term) continue;
    positive.push(term);
    const bare = unquote(word).toLowerCase();
    if (SESSION_ID.test(bare)) sessionIds.push(bare);
    else plain.push(term);
  }
  if (kinds.length) filters.kinds = [...new Set(kinds)];
  return {
    match: matchText(positive),
    rest: sessionIds.length ? matchText(plain) : null,
    sessionIds,
    exclude: negative.length ? negative.join(" OR ") : null,
    filters,
    thinking: kinds.includes("thinking"),
  };
}

/** Joins terms and operators, dropping an operator with no term on one side, so the text always parses. */
function matchText(parts: string[]): string | null {
  const out: string[] = [];
  for (const part of parts) {
    const operator = OPERATORS.has(part);
    if (operator && (!out.length || OPERATORS.has(out.at(-1)!))) continue;
    out.push(part);
  }
  while (out.length && OPERATORS.has(out.at(-1)!)) out.pop();
  return out.length ? out.join(" ") : null;
}
