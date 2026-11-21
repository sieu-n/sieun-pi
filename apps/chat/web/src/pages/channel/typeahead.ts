import { CHIP_MARK } from "./composer-dom";

/** `@` agents, `#` channels, `:` emoji by Slack name, and `/` commands at the start of the draft. */
export type Trigger = "@" | "#" | ":" | "/";
export type Query = { trigger: Trigger; start: number; text: string };

/** Longest query kept open, so a name with spaces such as "Crawler VP" still matches. */
const MAX_QUERY = 40;

/** Slack opens its emoji list after `:` and two letters, so a time such as 10:30 or a smiley :) opens nothing. */
const EMOJI_QUERY = /^[a-z0-9_+-]{2,}$/i;
const COMMAND_QUERY = /^[a-z]*$/i;

/**
 * The open query that ends at the caret, or null.
 * The trigger must start the text or follow whitespace or an opening bracket. An @ or # query may hold spaces but no newline, an emoji
 * query is a name of two or more letters, and a command query is the letters right after a `/` that starts the draft.
 */
export function openQuery(text: string, caret: number): Query | null {
  const head = text.slice(0, caret);
  for (let index = head.length - 1; index >= 0 && head.length - index <= MAX_QUERY + 1; index--) {
    const char = head[index];
    if (char === "\n" || char === CHIP_MARK) return null;
    if (char !== "@" && char !== "#" && char !== ":" && char !== "/") continue;
    const before = index === 0 ? " " : (head[index - 1] ?? " ");
    if (!/[\s([]/.test(before)) continue;
    const query = head.slice(index + 1);
    if (char === ":") {
      if (EMOJI_QUERY.test(query)) return { trigger: char, start: index, text: query };
      continue;
    }
    if (char === "/") {
      if (index === 0 && COMMAND_QUERY.test(query)) return { trigger: char, start: index, text: query };
      continue;
    }
    if (query.startsWith(" ") || /\s{2}/.test(query)) return null;
    return { trigger: char, start: index, text: query };
  }
  return null;
}

/** `:name:` typed whole at the caret, which Slack turns into its emoji: the name without colons, or null. */
export function closedEmojiName(text: string, caret: number): string | null {
  const hit = /(?:^|[\s([]):([a-z0-9_+-]+):$/i.exec(text.slice(0, caret));
  return hit?.[1] ?? null;
}

/** A `/name` command the composer runs instead of posting, such as /topic in a channel. `mentions` are the agent chips in its arguments. */
export type SlashCommand = {
  name: string;
  /** What goes after the name, such as `[text]` or `@agent`, shown at the right of its row. */
  args?: string;
  description: string;
  run: (input: { args: string; mentions: string[] }) => void | Promise<void>;
};

/** A draft that is a slash command: `/name` alone or followed by its arguments. A path such as /home/x is no command. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const hit = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return hit ? { name: hit[1]!.toLowerCase(), args: (hit[2] ?? "").trim() } : null;
}

export type Candidate = { id: string; name: string; kind: string };

function rank(name: string, query: string): number {
  const lower = name.toLowerCase();
  if (!query) return 3;
  if (lower.startsWith(query)) return 0;
  if (lower.split(/[\s\-_/]+/).some(word => word.startsWith(query))) return 1;
  if (lower.includes(query)) return 2;
  return -1;
}

/** Candidates that match the query, best first, keeping the given order inside each rank so the list never jumps. */
export function matchCandidates<C extends Candidate>(candidates: readonly C[], query: string, limit = 8): C[] {
  const needle = query.trim().toLowerCase();
  return candidates
    .map((candidate, order) => ({ candidate, order, score: rank(candidate.name, needle) }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, limit)
    .map(entry => entry.candidate);
}

/** Space completes a mention only when the typed name is exact and unique, so prose after "@Ann" keeps working. */
export function exactUnique<C extends Candidate>(candidates: readonly C[], query: string): C | null {
  const needle = query.trim().toLowerCase();
  const hits = candidates.filter(candidate => candidate.name.toLowerCase() === needle);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}
