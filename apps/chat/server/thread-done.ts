/**
 * The done flag on a thread, as Slack's resolved threads and the owner asked on 11-20 in #sw-factory-build (p113): "끝난 쓰레드를 Check로
 * 살짝 흐릿하게 만들수 있으면 좋겠다. make it a boolean flag that applies to the root thread message, and view/editable by agent too".
 *
 * The flag lives on the thread's root post (`RoomPost.done`). In a channel that is the post a thread hangs off; in a DM, which has no
 * threads, every post is its own root. The owner sets it from the page (`POST /api/c/:id/posts/:post/done`), naming any post of the thread.
 * A new reply of the owner's in a done thread reopens it, as a reply to a resolved Slack thread does; an agent's reply leaves it done.
 *
 * The check is his alone. On 11-24 (#sw-factory-build p177, c236) he wrote "Agent가 Done Check하는 기능 없애", so pi-host lost its
 * set_thread_done tool and the agent route `POST /api/threads/:thread/done` answers 403 with `AGENT_DONE_REFUSED`. A flag an agent set
 * before then still reads `by` that agent.
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

/** The 403 an agent's call to the old done route gets. */
export const AGENT_DONE_REFUSED = "The done check on a thread is the owner's alone, so an agent never marks a thread done or opens one (c236). " +
  "Take 👀 off the post with set_emoji instead.";
