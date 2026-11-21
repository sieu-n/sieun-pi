/**
 * Slack's Forward message: the owner forwards a post of a DM, a channel or a Solo room into any room, with words of his own or none, from
 * the post's hover bar (the p142 gap hunt, owner msg mwqu7lw9). The forward keeps a copy of the post as it read then (`RoomPost.forward`),
 * so its quote card stays the same after the post is edited or deleted, and the agents of the room read the quote under his words.
 */
import type { ForwardedPost, Principal, PostRef } from "../web/src/lib/api/types.ts";
import type { RoomPost } from "./agent-store.ts";

/** The `forward` of a send, checked: a room id and a post id. */
export function forwardInput(input: unknown): PostRef {
  const ref = input as { room?: unknown; post?: unknown } | null;
  if (typeof ref?.room !== "string" || typeof ref.post !== "string") throw new Error("A forward names its post as { room, post }, such as { room: \"ch_x\", post: \"p12\" }.");
  return { room: ref.room, post: ref.post };
}

/** The copy of `post` a forward keeps. Forwarding a forward that has no words of its own forwards the post it quotes, as Slack does. */
export function forwardOf(post: RoomPost, roomName: string, principal: (id: string) => Principal): ForwardedPost {
  if (post.deletedAt !== undefined) throw new Error(`${post.id} in ${post.room} is deleted, so it cannot be forwarded.`);
  if (post.forward && !post.text.trim() && !post.images.length) return post.forward;
  return {
    room: post.room, roomName, post: post.id, ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}), author: principal(post.author), text: post.text,
    images: post.images, at: post.at,
  };
}

/** Where a forwarded post was, as an agent reads it. */
const placeOf = (forward: ForwardedPost): string =>
  forward.room.startsWith("ch_") ? `#${forward.roomName}` : forward.room.startsWith("dm_") ? `the DM with ${forward.roomName}` : `Solo "${forward.roomName}"`;

/** A post's text with the post it forwards quoted under it, as the room's agents read the post. */
export function withForward(text: string, forward: ForwardedPost | undefined): string {
  if (!forward) return text;
  const files = forward.images.length ? [`> [${forward.images.length} file${forward.images.length > 1 ? "s" : ""} attached]`] : [];
  const quote = [
    `[forwarded post ${forward.post} from ${forward.author.name} in ${placeOf(forward)} (${forward.room}), written ${new Date(forward.at).toISOString()}]`,
    ...forward.text.split("\n").map(line => `> ${line}`), ...files,
  ].join("\n");
  return text.trim() ? `${text}\n\n${quote}` : quote;
}

/** The forward as the page reads it. */
export const forwardPart = (post: RoomPost): { forward?: ForwardedPost } => (post.forward && post.deletedAt === undefined ? { forward: post.forward } : {});
