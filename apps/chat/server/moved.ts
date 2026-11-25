/**
 * The read-before-send check on an agent's post (owner p221 and his pick p226 of fable auditor's p222 in #sw-factory-build): when the
 * thread a post goes in moved since the agent last read it, the post is held once, the agent gets the new posts and nothing goes out. Its
 * next send, the same text or a rewrite, goes out unless the thread moved again. On 11-25 in #dev-crawler devops guy's p46 said "We agree on
 * everything" 10 s after the owner's p45, and search-product-misc's p47 disagreed on two details 3 s later; 52 of 337 agent posts in the 7
 * days before had missed a newer post of their thread (~/work/read-and-send/c-measure.md).
 *
 * What an agent read is kept on its comm thread's feed cursor (`FeedCursor.read`): the time the run started and the posts its inputs showed,
 * by their headers and the "(thread so far)" lines of a room post's envelope (group-rooms.ts `envelope`), the owner posts whose input
 * entered the thread (`RoomPost.inputs`), and the posts a hold showed. A post another member wrote or edited after the run started that is
 * none of these moved the thread. The feed reads the thread's entries in order, so an input still waiting in pi-host's inbox, such as a
 * steer that waits for the end of a tool round or an agent post that waits for the run's end, counts as unread.
 */
import type { FeedCursor, RoomPost } from "./agent-store.ts";
import type { EntryRecord, Message } from "./host/types.ts";

export type ReadMark = NonNullable<FeedCursor["read"]>;

const CONTEXT_HEAD = /^\((thread so far|channel before this post|pinned in this room)\)$/;
const CONTEXT_LINE = /^(\d+) \S/;
const HEADER = /· post (\d+) from [^\n]* · hops \d+\]$/;
const EDIT_NOTICE = /^\[The owner edited post (p\d+) in /;

const textOf = (entry: EntryRecord): string => {
  const content = entry.model?.[0]?.content;
  return typeof content === "string" ? content : (content ?? []).flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n");
};

/** The posts an input shows by id: each post header, each line of its context sections, and the post an owner edit notice names. */
export function shownIn(entry: EntryRecord): string[] {
  const ids: string[] = [];
  let context = false;
  for (const line of textOf(entry).split("\n")) {
    const header = HEADER.exec(line);
    if (header) ids.push(`p${header[1]}`);
    if (CONTEXT_HEAD.test(line)) context = true;
    else if (!line.trim()) context = false;
    else if (context) {
      const seq = CONTEXT_LINE.exec(line);
      if (seq) ids.push(`p${seq[1]}`);
    }
  }
  return ids;
}

/**
 * The read mark after one input entry: a run's first input starts a new mark at its time, and every input adds the posts it shows, each
 * with the time it was read, so an edit made before that time counts as read too.
 */
export function readInput(mark: ReadMark | undefined, entry: EntryRecord): ReadMark {
  const at = entry.model?.[0]?.timestamp ?? Date.now();
  const next: ReadMark = !mark || mark.ended ? { at, seen: [] } : { ...mark, seen: [...mark.seen] };
  const notice = EDIT_NOTICE.exec(textOf(entry).trim());
  for (const id of [...shownIn(entry), ...(notice ? [notice[1]!] : [])]) next.seen.push(`${id}@${at}`);
  return next;
}

/** The mark after an assistant message: a message that ends the run, not a tool round or a failed request the pool retries, ends it. */
export function readAnswer(mark: ReadMark | undefined, message: Message | undefined): ReadMark | undefined {
  if (!mark || message?.role !== "assistant") return mark;
  const stop = (message as { stopReason?: string }).stopReason ?? "";
  return ["toolUse", "error"].includes(stop) ? mark : { ...mark, ended: true };
}

/** When `id` was last read in this run, or undefined when it was not. */
function readAt(mark: ReadMark, id: string): number | undefined {
  let at: number | undefined;
  for (const key of mark.seen) {
    const sep = key.lastIndexOf("@");
    if (key.slice(0, sep) === id) at = Math.max(at ?? 0, Number(key.slice(sep + 1)));
  }
  return at;
}

/** A post that moved the thread since the mark, and whether it is new or an edit. */
export interface Moved { post: RoomPost; edited: boolean }

/**
 * The posts of the thread rooted at `root` (the room's root posts when undefined) that another member wrote or edited since the run started
 * and the agent did not read. `thread` is the agent's comm thread, whose owner inputs `RoomPost.inputs` records.
 */
export function movedPosts(posts: readonly RoomPost[], agent: string, thread: string, mark: ReadMark | undefined, root: string | undefined): Moved[] {
  if (!mark || mark.ended) return [];
  const inScope = (p: RoomPost) => (root ? p.id === root || p.threadRoot === root : !p.threadRoot);
  const scope = posts.filter(inScope);
  // Before the run, a post after the agent's own last post there counts as read only when it was delivered to this thread: a thread reply
  // wakes only the agents in that thread, so 4 of 93 missed posts on 11-25 never reached the agent (fable auditor's findings).
  const since = scope.findLast(p => p.author === agent && p.at <= mark.at)?.at ?? -Infinity;
  const delivered = (p: RoomPost) => [...(p.deliveries ?? []), ...(p.delivery ? [p.delivery] : [])].some(d => d.thread === thread && d.state === "delivered");
  const out: Moved[] = [];
  for (const post of scope) {
    if (post.author === agent || post.deletedAt !== undefined || post.imported) continue;
    const read = readAt(mark, post.id) ?? post.inputs?.find(i => i.thread === thread)?.at;
    if (post.at > mark.at ? read === undefined : post.at > since && read === undefined && !delivered(post)) out.push({ post, edited: false });
    else if (post.editedAt !== undefined && post.editedAt > mark.at && (read === undefined || read < post.editedAt)) out.push({ post, edited: true });
  }
  return out;
}

/** The mark once a hold showed `moved`: each post counts as read at `now`. */
export function readMoved(mark: ReadMark, moved: readonly Moved[], now: number): ReadMark {
  return { ...mark, seen: [...mark.seen, ...moved.map(m => `${m.post.id}@${now}`)] };
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 19) + "Z";

/** The header a held call and read_post (later-agents.ts `read`) put over each post they show: `[post 47 (p47) from devops guy, at 11:02:24Z]`. */
export function postHeader(post: RoomPost, name: string, edited = false): string {
  return `[post ${post.seq} (${post.id}) from ${name}, ${edited ? `edited at ${clock(post.editedAt!)}` : `at ${clock(post.at)}`}]`;
}

/** The held call's answer: the new posts, each under a header that names it, and what to do next. */
export function movedNote(moved: readonly Moved[], name: (author: string) => string, what: "post" | "edit"): string {
  // Each post whole, not clipped as the envelope's thread lines are: a hold carried a median of 2 posts and a p90 of 5 on 11-25 (fable auditor).
  const lines = moved.map(({ post, edited }) => `${postHeader(post, name(post.author), edited)}\n${post.text}`);
  return [
    `Not ${what === "post" ? "sent" : "edited"}: the thread moved since you last read it. ${moved.length === 1 ? "This post is" : `These ${moved.length} posts are`} new to you:`,
    "", ...lines, "",
    `Read ${moved.length === 1 ? "it" : "them"}, then call the tool again: the same text goes out as it is, a rewrite takes them into account, ` +
      "and no call is right when they already answer it.",
  ].join("\n");
}
