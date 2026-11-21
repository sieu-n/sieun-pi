/**
 * Slack's Pin to channel: the owner pins a post of a DM, a channel or a Solo room from its More actions menu, the post shows "Pinned by
 * you" over its text, and the room header's Pinned button lists the room's pinned posts (the p142 gap hunt, owner msg mwqu7lw9).
 *
 * The flag lives on the post (`RoomPost.pinned`), any post a thread reply included, as in Slack. Un-pinning keeps the row with
 * `pinned: false`, as `done` does, so the log records who took it off. A deleted post leaves the room's pinned list.
 */
import type { Principal, PostPin } from "../web/src/lib/api/types.ts";
import type { RoomPost, StoredPin } from "./agent-store.ts";
import { ReactionError } from "./reactions.ts";

/** The `pinned` of a request: true pins the post, false un-pins it. */
export function pinInput(input: { pinned?: unknown }): boolean {
  if (typeof input.pinned !== "boolean") throw new ReactionError(400, "A post's pinned is true to pin it or false to un-pin it.");
  return input.pinned;
}

/** The post's flag after the owner pins or un-pins it, or undefined when it already reads that way. */
export function markPin(post: RoomPost, pinned: boolean, at = Date.now()): StoredPin | undefined {
  if ((post.pinned?.pinned ?? false) === pinned) return undefined;
  if (pinned && post.deletedAt !== undefined) throw new ReactionError(400, `${post.id} in ${post.room} is deleted, so it cannot be pinned.`);
  return { pinned, by: "owner", at };
}

/** The flag as the page reads it: present only while the post is pinned. */
export function pinOf(principal: (id: string) => Principal, post: RoomPost): { pinned?: PostPin } {
  return post.pinned?.pinned && post.deletedAt === undefined ? { pinned: { by: principal(post.pinned.by), at: post.pinned.at } } : {};
}

/** The one form every agent-facing surface shows the flag in, `[pinned by Sieun (owner)]`, or "" while the post is not pinned. */
export function pinLine(post: RoomPost): string {
  return post.pinned?.pinned && post.deletedAt === undefined ? "[pinned by Sieun (owner)]" : "";
}

/**
 * The room's pinned posts as an agent reads them under the post it answers, `(pinned in this room)` and one `line` each, so "what is pinned
 * here?" reads from its own input, as the header shows the owner; no lines while nothing is pinned.
 */
export function pinnedSection(posts: readonly RoomPost[], line: (post: RoomPost) => string): string[] {
  const pins = pinnedPosts(posts);
  return pins.length ? ["", "(pinned in this room)", ...pins.map(line)] : [];
}

/** The room's pinned posts, newest pin first, as Slack's Pinned list orders them. */
export function pinnedPosts(posts: readonly RoomPost[]): RoomPost[] {
  return posts.filter(p => p.pinned?.pinned && p.deletedAt === undefined).sort((a, b) => (b.pinned?.at ?? 0) - (a.pinned?.at ?? 0));
}
