/**
 * Reactions on room posts, as in Slack, with one model for the owner and agents: each principal puts an emoji on a post once and takes its
 * own off (`react`). The owner reacts from the page (`POST /api/c/:id/posts/:post/reactions`) and an agent with its set_emoji tool
 * (`POST /api/threads/:thread/reactions`), which names the post as `agentPost` reads it. No emoji means anything to the server: the 👀 an
 * agent puts on the post it works on is a reaction its role text asks it to set (/home/sieun/work/slack-reactions/contract.md).
 *
 * Every surface that shows a room post to an agent shows its reactions as `reactionsLine` writes them.
 */
import type { Principal, Reaction } from "../web/src/lib/api/types.ts";
import { emojiOf } from "../web/src/lib/api/shared/emoji.ts";
import type { AgentRecord, RoomId, RoomPost, StoredReaction } from "./agent-store.ts";

/** A reaction request the server refuses: 400 for a bad emoji or message id, 404 for a room or post that is not there. */
export class ReactionError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
  }
}

/** The owner as an agent reads him in a post's reactions. */
const OWNER_FOR_AGENTS = "Sieun (owner)";

/** A post's reactions as the page shows them: one row per emoji, in the order each first came, with who put it on. */
export function reactionsOf(principal: (id: string) => Principal, post: RoomPost): { reactions?: Reaction[] } {
  const by = new Map<string, Principal[]>();
  for (const r of post.reactions ?? []) by.set(r.emoji, [...(by.get(r.emoji) ?? []), principal(r.by)]);
  return by.size ? { reactions: [...by].map(([emoji, people]) => ({ emoji, by: people })) } : {};
}

/** A post's reactions as an agent reads them, such as `👀 vent, agent factory · 👍 Sieun (owner)`, or "" with none. */
export function reactionList(principal: (id: string) => Principal, post: RoomPost): string {
  const rows = reactionsOf(principal, post).reactions ?? [];
  return rows.map(row => `${row.emoji} ${row.by.map(p => (p.kind === "owner" ? OWNER_FOR_AGENTS : p.name)).join(", ")}`).join(" · ");
}

/** The one form every agent-facing surface shows a post's reactions in: `[reactions: 👀 vent, agent factory · 👍 Sieun (owner)]`, or "" with none. */
export function reactionsLine(principal: (id: string) => Principal, post: RoomPost): string {
  const list = reactionList(principal, post);
  return list ? `[reactions: ${list}]` : "";
}

/** The emoji and direction of a reaction request: a Slack name (`eyes`, `:eyes:`) or the emoji itself, and `on`, true unless given. */
export function reactionInput(input: { emoji?: unknown; on?: unknown }): { emoji: string; on: boolean } {
  const info = typeof input.emoji === "string" ? emojiOf(input.emoji) : undefined;
  if (!info) throw new ReactionError(400, `No emoji is named ${JSON.stringify(input.emoji ?? "")}; pass a Slack name such as eyes, white_check_mark or +1, or the emoji itself.`);
  if (input.on !== undefined && typeof input.on !== "boolean") throw new ReactionError(400, "A reaction's on is true to put the emoji on or false to take it off.");
  return { emoji: info.char, on: input.on ?? true };
}

/** The post's reactions after `by` puts `emoji` on (`on`) or takes its own off, or undefined when nothing changes. */
export function react(post: RoomPost, by: StoredReaction["by"], emoji: string, on: boolean): StoredReaction[] | undefined {
  const list = post.reactions ?? [];
  if (list.some(r => r.by === by && r.emoji === emoji) === on) return undefined;
  return on ? [...list, { emoji, by, at: Date.now() }] : list.filter(r => !(r.by === by && r.emoji === emoji));
}

/** When the delivery of `post` to `record` reached `thread`, or undefined; a DM delivery from before the split went to the work thread. */
function deliveredAt(post: RoomPost, record: AgentRecord, thread: string): number | undefined {
  const d = post.delivery ?? post.deliveries?.find(x => x.target === record.id);
  if (!d || d.target !== record.id || d.state !== "delivered" || (d.thread ?? record.workThread) !== thread) return undefined;
  return d.at;
}

/** The post an agent's message id names among a room's posts, which reach the agent through `thread`. */
export function agentPost(posts: readonly RoomPost[], record: AgentRecord, thread: string, room: RoomId, id: string): RoomPost {
  const seq = /^(?:post\s+|p)?(\d+)$/i.exec(id.trim());
  if (seq) {
    const post = posts.find(p => p.seq === Number(seq[1]));
    if (!post) throw new ReactionError(404, `No post p${seq[1]} in ${room}; pass a post id from a post header or a room read, such as p12.`);
    return post;
  }
  // A Prime message id is the base-36 time pi-host stamped on the input (chat-feed.ts ownerMessageId), which falls between the post and its delivery.
  const at = /^[0-9a-z]{6,10}$/.test(id.trim()) ? parseInt(id.trim(), 36) : NaN;
  if (!Number.isFinite(at)) {
    throw new ReactionError(400, `${JSON.stringify(id)} names no message; pass a post id such as p12, a room-qualified id such as ${room}/p12, or the [message id: ...] value after an owner message.`);
  }
  let within: RoomPost | undefined;
  let before: RoomPost | undefined;
  for (const post of posts) {
    const delivered = deliveredAt(post, record, thread);
    if (delivered === undefined || post.at > at) continue;
    before = post;
    if (at <= delivered) within = post;
  }
  const post = within ?? before;
  if (!post) throw new ReactionError(404, `No post in ${room} reached you by message id ${id}; pass the post id from its header, such as p12.`);
  return post;
}

/** The one line set_emoji answers with, such as `👀 is on p12 in dm_vent. Reactions now: 👀 vent · 👍 Sieun (owner).` */
export function reactionText(principal: (id: string) => Principal, post: RoomPost, emoji: string, on: boolean, qualified: boolean): string {
  const where = qualified ? `${post.room}/${post.id}` : `${post.id} in ${post.room}`;
  return `${emoji} is ${on ? "on" : "off"} ${where}. Reactions now: ${reactionList(principal, post) || "none"}.`;
}
