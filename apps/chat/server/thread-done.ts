/**
 * The done flag on a thread, as Slack's resolved threads and the owner asked on 11-20 in #sw-factory-build (p113): "끝난 쓰레드를 Check로
 * 살짝 흐릿하게 만들수 있으면 좋겠다. make it a boolean flag that applies to the root thread message".
 *
 * The flag lives on the thread's root post (`RoomPost.done`). In a channel that is the post a thread hangs off; in a DM, which has no
 * threads, every post is its own root. The owner sets it from the page (`POST /api/c/:id/posts/:post/done`), naming any post of the thread.
 * A new reply of the owner's in a done thread reopens it, as a reply to a resolved Slack thread does; an agent's reply leaves it done.
 *
 * Every surface that shows a room post to an agent shows the flag next to its reactions as `doneLine` writes it.
 */
import type { ThreadDone } from "../web/src/lib/api/types.ts";
import type { RoomPost, StoredDone } from "./agent-store.ts";
import { ReactionError } from "./reactions.ts";

/** The root post of the thread `post` is in: the post itself, or the root a channel reply hangs off. */
export function threadRootOf(posts: readonly RoomPost[], post: RoomPost): RoomPost {
  if (!post.threadRoot) return post;
  const root = posts.find(p => p.id === post.threadRoot);
  if (!root) throw new ReactionError(404, `${post.id} in ${post.room} is a reply in thread ${post.threadRoot}, which is not there any more.`);
  return root;
}

/** The `done` of a request: true marks the thread done, false reopens it. */
export function doneInput(input: { done?: unknown }): boolean {
  if (typeof input.done !== "boolean") throw new ReactionError(400, "A thread's done is true to mark it done or false to reopen it.");
  return input.done;
}

/** The root's flag after the owner marks its thread done or reopens it, or undefined when it already reads that way. */
export function markDone(root: RoomPost, done: boolean, at = Date.now()): StoredDone | undefined {
  if ((root.done?.done ?? false) === done) return undefined;
  return { done, at };
}

/** The flag as the page reads it: present only while the thread is done. */
export function doneOf(post: RoomPost): { done?: ThreadDone } {
  return post.done?.done ? { done: { at: post.done.at } } : {};
}

/** The one form every agent-facing surface shows the flag in, `[thread done]`, or "" while the thread is open. */
export function doneLine(post: RoomPost): string {
  return post.done?.done ? "[thread done]" : "";
}

/** Whether `reply` reopens the done thread of `root`: an owner reply in that thread, as a reply reopens a resolved Slack thread. */
export function reopens(root: RoomPost, reply: RoomPost): boolean {
  return reply.author === "owner" && reply.threadRoot === root.id && root.done?.done === true;
}
