/**
 * The done flag on a thread, as Slack's resolved threads and the owner asked on 11-20 in #sw-factory-build (p113): "끝난 쓰레드를 Check로
 * 살짝 흐릿하게 만들수 있으면 좋겠다. make it a boolean flag that applies to the root thread message, and view/editable by agent too".
 *
 * The flag lives on the thread's root post (`RoomPost.done`). In a channel that is the post a thread hangs off; in a DM, which has no
 * threads, every post is its own root. The owner sets it from the page (`POST /api/c/:id/posts/:post/done`) and an agent with its
 * set_thread_done tool (`POST /api/threads/:thread/done`); both name any post of the thread and go through app.ts `setThreadDone`.
 * A new reply of the owner's in a done thread reopens it, as a reply to a resolved Slack thread does; an agent's reply leaves it done.
 *
 * Every surface that shows a room post to an agent shows the flag next to its reactions as `doneLine` writes it.
 */
import type { Principal, ThreadDone } from "../web/src/lib/api/types.ts";
import type { RoomPost, StoredDone } from "./agent-store.ts";
import { ReactionError } from "./reactions.ts";

const OWNER_FOR_AGENTS = "Sieun (owner)";

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

/** The root's flag after `by` marks its thread done or reopens it, or undefined when it already reads that way. */
export function markDone(root: RoomPost, by: StoredDone["by"], done: boolean, at = Date.now()): StoredDone | undefined {
  if ((root.done?.done ?? false) === done) return undefined;
  return { done, by, at };
}

/** The flag as the page reads it: present only while the thread is done. */
export function doneOf(principal: (id: string) => Principal, post: RoomPost): { done?: ThreadDone } {
  return post.done?.done ? { done: { by: principal(post.done.by), at: post.done.at } } : {};
}

/** The one form every agent-facing surface shows the flag in, `[thread done by vent]`, or "" while the thread is open. */
export function doneLine(principal: (id: string) => Principal, post: RoomPost): string {
  if (!post.done?.done) return "";
  const who = principal(post.done.by);
  return `[thread done by ${who.kind === "owner" ? OWNER_FOR_AGENTS : who.name}]`;
}

/** Whether `reply` reopens the done thread of `root`: an owner reply in that thread, as a reply reopens a resolved Slack thread. */
export function reopens(root: RoomPost, reply: RoomPost): boolean {
  return reply.author === "owner" && reply.threadRoot === root.id && root.done?.done === true;
}

/** The one line set_thread_done answers with, such as `The thread of p12 in ch_1a2b3c4d is done; the room shows it with a check.` */
export function doneText(root: RoomPost, done: boolean, changed: boolean): string {
  const where = `The thread of ${root.id} in ${root.room}`;
  if (!changed) return `${where} is already ${done ? "done" : "open"}; nothing changed.`;
  return done ? `${where} is done; the room shows it with a check, and a new reply from the owner reopens it.` : `${where} is open again.`;
}
