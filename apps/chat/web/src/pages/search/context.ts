/**
 * The messages around a hit, which the results page shows dimmed above and below it. They come from the conversation's own page around
 * the hit (`items?around=`), so they read as the conversation does: the ask before an answer, and for a hit in a tool's output the ask
 * and the answer of the turn that ran it.
 */
import type { Item, TimelinePage } from "../../lib/api/types.ts";
import type { Hit } from "./hit-view.ts";

export type ContextLine = { id: string; author: string; kind: "owner" | "agent" | "system"; at: number; text: string };
export type HitContext = { before?: ContextLine | undefined; after?: ContextLine | undefined };

const MAX = 280;

/** Prime's envelopes name the real sender or mark a note, as the search hit itself does. */
const ENVELOPES: readonly [RegExp, (m: RegExpExecArray) => { author?: string; kind?: ContextLine["kind"] }][] = [
  [/^\[agent-message from (?:child:)?([^\]]+)\]\s*/, m => ({ author: m[1]!, kind: "agent" })],
  [/^\[#[^\]]*\]\s*/, () => ({})],
  [/^\[(job|check-in|board|chat server|harness-digest|auto-refinement|child-exited[^\]]*|child-failed[^\]]*)\]\s*/, () => ({ author: "System", kind: "system" })],
  [/^The conversation history before this point was compacted into the following summary:\s*/, () => ({ author: "Summary", kind: "system" })],
];

function line(item: Item | undefined): ContextLine | undefined {
  if (!item) return undefined;
  let text = item.text.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  let who: ContextLine["kind"] = item.kind === "system" ? "system" : item.author.kind === "owner" ? "owner" : "agent";
  let name = item.kind === "system" ? "System" : item.author.kind === "owner" ? "You" : item.author.name;
  for (const [re, read] of ENVELOPES) {
    const m = re.exec(text);
    if (!m) continue;
    const found = read(m);
    text = text.slice(m[0].length);
    if (found.author) name = found.author;
    if (found.kind) who = found.kind;
    break;
  }
  const short = text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
  return { id: item.id, author: name, kind: who, at: item.at, text: short };
}

/** The line before and after the item that holds the hit, from the page around it. */
export function contextOf(page: TimelinePage, hit: Hit): HitContext {
  const at = page.items.findIndex(item => item.id === (page.focus ?? hit.messageId));
  if (at < 0) return {};
  const focus = page.items[at]!;
  const inTool = hit.role === "tool" || hit.kind === "tool";
  // A hit inside a turn's tool step: the turn's own answer is the line after it.
  const after = inTool && focus.kind === "turn" && focus.text.trim() ? line(focus) : line(page.items[at + 1]);
  return { before: line(page.items[at - 1]), after };
}

/** A reply in a channel thread: the post before it in the thread (or the root) and the reply after it. */
export function replyContextOf(thread: { root: Item; items: Item[] }, hit: Hit): HitContext {
  const all = [thread.root, ...thread.items];
  const at = all.findIndex(item => item.id === hit.messageId);
  if (at < 0) return { before: line(thread.root) };
  return { before: line(all[at - 1]), after: line(all[at + 1]) };
}
