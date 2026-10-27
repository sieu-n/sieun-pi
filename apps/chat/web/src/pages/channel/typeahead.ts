export type Trigger = "@" | "#";
export type Query = { trigger: Trigger; start: number; text: string };

/** Longest query kept open, so a name with spaces such as "Crawler VP" still matches. */
const MAX_QUERY = 40;

/**
 * The open @ or # query that ends at the caret, or null.
 * The trigger must start the text or follow whitespace or an opening bracket, and the query may hold spaces but no newline.
 */
export function openQuery(text: string, caret: number): Query | null {
  const head = text.slice(0, caret);
  for (let index = head.length - 1; index >= 0 && head.length - index <= MAX_QUERY + 1; index--) {
    const char = head[index];
    if (char === "\n") return null;
    if (char !== "@" && char !== "#") continue;
    const before = index === 0 ? " " : (head[index - 1] ?? " ");
    if (!/[\s([]/.test(before)) continue;
    const query = head.slice(index + 1);
    if (query.startsWith(" ") || /\s{2}/.test(query)) return null;
    return { trigger: char, start: index, text: query };
  }
  return null;
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
