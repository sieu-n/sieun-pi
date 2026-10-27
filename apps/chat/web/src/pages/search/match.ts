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

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decode = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity]!);

/**
 * Splits a server snippet into runs. The server sends text with `<mark>` tags around matches, and this never renders
 * it as HTML, so a message that holds markup shows as text.
 */
export function snippetPieces(snippet: string): Piece[] {
  const out: Piece[] = [];
  const parts = snippet.split(/(<mark>|<\/mark>)/);
  let mark = false;
  for (const part of parts) {
    if (part === "<mark>") mark = true;
    else if (part === "</mark>") mark = false;
    else if (part) out.push({ text: decode(part).replace(/\s+/g, " "), mark });
  }
  return out;
}
