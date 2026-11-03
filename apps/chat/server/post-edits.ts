/**
 * Slack's Edit message and Delete message for the owner's own room posts (DMs, channels and Solo rooms).
 *
 * An edit keeps the post where it is with its new text and an `editedAt` the page shows as "(edited)". A delete keeps the post as a stub with
 * no text or images and a `deletedAt`: the page drops it, or shows "This message was deleted." on a channel root that has replies, as Slack
 * does, and search, previews and the context lines agents read lose its words. A delivery still on its way carries the new text, or stops for
 * a deleted post. Each agent that already read the post gets the change as an owner input, so it acts on what the owner means now.
 */
import type { Item } from "../web/src/lib/api/types.ts";
import type { RoomDelivery, RoomPost } from "./agent-store.ts";

/** The edit and delete marks an Item carries. */
export function postState(post: RoomPost): Pick<Extract<Item, { kind: "message" }>, "editedAt" | "deleted"> {
  return { ...(post.editedAt !== undefined ? { editedAt: post.editedAt } : {}), ...(post.deletedAt !== undefined ? { deleted: true as const } : {}) };
}

/** The post's deliveries, one for a DM post and one per woken member in a group room. */
export const deliveriesOf = (post: RoomPost): RoomDelivery[] => (post.delivery ? [post.delivery] : post.deliveries ?? []);

const quote = (text: string): string => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

/** The owner input an agent that read the post gets after an edit. `place` is "your DM" or the room's label, such as "#vent-dev". */
export function editNotice(post: RoomPost, place: string, before: string): string {
  return `[The owner edited post ${post.id} in ${place}. It read "${quote(before)}" and now reads as below. Act on the new text, and do not answer the edit itself unless it asks something new.]\n\n${post.text}`;
}

/** The owner input an agent that read the post gets after a delete. */
export function deleteNotice(post: RoomPost, place: string, before: string): string {
  return `[The owner deleted post ${post.id} in ${place}, which read "${quote(before)}". Drop anything you did or planned because of it, and do not answer it.]`;
}

/** Throws unless the owner may edit or delete the post: his own, typed in the room, and not deleted yet. */
export function assertOwnPost(post: RoomPost): void {
  if (post.author !== "owner" || post.imported) throw new Error(`A post you edit or delete is your own post typed in the room; ${post.id} is not one.`);
  if (post.deletedAt !== undefined) throw new Error(`A deleted post takes no edit; ${post.id} was deleted.`);
}
