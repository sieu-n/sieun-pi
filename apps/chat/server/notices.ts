/**
 * The owner's notices: each new post someone else writes in a room he sees goes to every page as a `notice` event, with why it is for him,
 * and so does each For you ask whose Remind me comes due (boards.ts). The page decides from his notification setting whether to raise a
 * system notification (web/src/lib/notices.svelte.ts). Slack's default notifies for direct messages, mentions and replies in threads he
 * is in; "all" adds every other channel post.
 */
import type { AskNotice, ForYouItem, Ms, NoticeReason, PostNotice, Principal } from "../web/src/lib/api/types.ts";
import type { RoomPost, RoomRow } from "./agent-store.ts";

/** A post the feed appends later than this after it was written, such as one read back after a restart, raises no notice. */
export const NOTICE_FRESH_MS = 5 * 60_000;
const SNIPPET = 300;

/**
 * Why the post is for the owner, or undefined when it raises no notice: his own posts, imported history, archived rooms and stale posts.
 * A DM or Solo room post is `dm`, since every post there is to him; a channel post is `mention`, `reply` (it answers his post), `thread`
 * (it replies in a thread he wrote in) or `post`.
 */
export function noticeReason(row: RoomRow, post: RoomPost, posts: readonly RoomPost[], now: Ms): NoticeReason | undefined {
  if (post.author === "owner" || post.imported || post.deletedAt !== undefined || row.archived || now - post.at > NOTICE_FRESH_MS) return undefined;
  if (row.kind !== "channel") return "dm";
  if (post.mentions?.includes("owner")) return "mention";
  const byId = (id: string | undefined) => (id ? posts.find(p => p.id === id) : undefined);
  if (byId(post.answers)?.author === "owner") return "reply";
  if (post.threadRoot && posts.some(p => p.seq < post.seq && p.author === "owner" && (p.id === post.threadRoot || p.threadRoot === post.threadRoot))) return "thread";
  return "post";
}

/** The notice the page shows for the post. */
export function noticeOf(row: RoomRow, post: RoomPost, reason: NoticeReason, author: Principal, agentName: (id: string) => string): PostNotice {
  return {
    kind: "post", room: row.id, roomKind: row.kind, roomName: row.kind === "dm" ? agentName(row.agent) : row.kind === "channel" ? `#${row.name}` : row.name,
    post: post.id, ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}), author, reason, at: post.at, images: post.images.length,
    text: oneLine(post.text),
  };
}

/** The notice of a For you ask whose Remind me came due at `at`. */
export function askNoticeOf(item: ForYouItem, at: Ms): AskNotice {
  return { kind: "ask", chatId: item.chatId, chatName: item.chatName, todo: item.todo.id, text: oneLine(item.todo.text), at };
}

function oneLine(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET - 1)}…` : text;
}
