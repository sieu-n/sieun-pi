/** Name matching for search rows: a rank to order by and the code points to highlight. */

export type NameMatch = { rank: number; positions: number[] };

const isBoundary = (label: string, index: number) => index === 0 || /[\s\-_./#@(]/.test(label[index - 1]!);

/**
 * Ranks how `label` matches `needle`: 0 is the whole name, 1 a prefix, 2 a word prefix, 3 anywhere inside, and
 * undefined is no match. Every word of the needle has to match, so `pi host` finds "pi-host canary".
 */
export function matchName(label: string, needle: string): NameMatch | undefined {
  const text = label.toLowerCase();
  const query = needle.trim().toLowerCase().replace(/^[#@]/, "");
  if (!query) return undefined;
  if (text === query) return { rank: 0, positions: range(0, label.length) };
  const whole = text.indexOf(query);
  if (whole === 0) return { rank: 1, positions: range(0, query.length) };
  const words = query.split(/\s+/);
  let rank = 1;
  const positions: number[] = [];
  for (const word of words) {
    let at = -1;
    for (let index = text.indexOf(word); index >= 0; index = text.indexOf(word, index + 1)) {
      if (isBoundary(text, index)) {
        at = index;
        break;
      }
    }
    if (at >= 0) rank = Math.max(rank, at === 0 ? 1 : 2);
    else {
      at = text.indexOf(word);
      if (at < 0) return undefined;
      rank = 3;
    }
    positions.push(...range(at, at + word.length));
  }
  return { rank, positions: [...new Set(positions)].sort((a, b) => a - b) };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, index) => from + index);
}

export type Piece = { text: string; mark: boolean };

/** Splits a label into marked and plain runs from match positions. */
export function pieces(label: string, positions: readonly number[] = []): Piece[] {
  const marked = new Set(positions);
  const out: Piece[] = [];
  for (let index = 0; index < label.length; index += 1) {
    const mark = marked.has(index);
    const last = out.at(-1);
    if (last && last.mark === mark) last.text += label[index];
    else out.push({ text: label[index]!, mark });
  }
  return out;
}

/**
 * Cuts a snippet's text before its first match down to about `keep` characters, starting at a word, with … in front, so a
 * one-line row shows the match instead of the words that lead up to it.
 */
export function leadIn(pieces: readonly Piece[], keep = 24): Piece[] {
  const first = pieces.findIndex(piece => piece.mark);
  if (first <= 0) return [...pieces];
  const before = pieces.slice(0, first).map(piece => piece.text).join("");
  if (before.length <= keep) return [...pieces];
  const tail = before.slice(-keep);
  const word = tail.search(/\s\S/);
  const cut = word >= 0 ? tail.slice(word + 1) : tail;
  return [{ text: `…${cut}`, mark: false }, ...pieces.slice(first)];
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decode = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity]!);

const OPEN = "\u0001";
const CLOSE = "\u0002";

/**
 * Markdown's marks taken out of a snippet, so it reads as plain text: `**Decision**` reads Decision, `[docs](https://x)` reads docs, and a
 * heading, quote or list marker at a line start goes. A snippet is a cut of a message, so a mark can lose its pair; each mark goes on its own.
 */
export function plainMarkdown(text: string): string {
  return text
    .replace(/```[\w-]*/g, "")
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/^[ \t\u0001\u0002]*(?:#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, match => match.replace(/[^\u0001\u0002]/g, ""))
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(^|[\s(\u0001])[*_](?=[^\s*_])/g, "$1")
    .replace(/([^\s*_])[*_](?=[\s).,!?:;\u0002]|$)/g, "$1");
}

/**
 * Splits a server snippet into runs of plain text. The server sends text with `<mark>` tags around matches, and this never renders
 * it as HTML, so a message that holds markup shows as text, with its Markdown marks taken out.
 */
export function snippetPieces(snippet: string): Piece[] {
  const text = plainMarkdown(decode(snippet.replace(/<mark>/g, OPEN).replace(/<\/mark>/g, CLOSE)));
  const out: Piece[] = [];
  let mark = false;
  for (const part of text.split(/([\u0001\u0002])/)) {
    if (part === OPEN) mark = true;
    else if (part === CLOSE) mark = false;
    else if (part) out.push({ text: part.replace(/\s+/g, " "), mark });
  }
  return out;
}
