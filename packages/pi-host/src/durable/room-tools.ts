/**
 * Tools an agent uses on the posts of its rooms, through apps/chat's HTTP API (`chat-app.ts`). One extension, `room-tools`, which a thread's
 * root conversation runs when the host loaded Prime's chat extension; a job's child conversation drops it by name (`RoomToolsName`), as it
 * drops the chat's own tools.
 *
 * `set_emoji` puts the agent's reaction on a post or takes it off, as Slack's `reactions.add` and `reactions.remove` do. The comm role text
 * asks the agent to mark the post it works on with 👀, take it off once its reply goes out, keep ✅ for a quick ask a reply would add nothing
 * to, and react the way people do in Slack (`agent-profile.ts`); no code here treats an emoji specially (contract: /home/sieun/work/slack-reactions/contract.md).
 *
 * `edit_message` replaces the text of one of the agent's own posts, as Slack's `chat.update` does, through apps/chat's edit of the owner's
 * posts (app.ts `rewrite`): the room shows it with (edited) at once and no new post. An agent posts a checklist of what it will check and
 * edits that same post as items finish, instead of a new post per step (owner p106, c207).
 *
 * `list_for_me_messages` and `mark_message` (`for-me.ts`) read the agent's For list and mark its items, and `save_message`, `remind_me` and
 * `list_saved_messages` (`later.ts`) keep its Later list, and `search_messages` (`search-messages.ts`) runs the owner's Cmd K search with his filters.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, ROOT_CONVERSATION_ID, type Extension } from "@earendil-works/pi-durable";
import type { ChatApp } from "./chat-app.ts";
import { forMeTools } from "./for-me.ts";
import { laterTools } from "./later.ts";
import { searchTools } from "./search-messages.ts";

export const ROOM_TOOLS_EXTENSION = "room-tools";
export const SET_EMOJI_TOOL = "set_emoji";
export const EDIT_MESSAGE_TOOL = "edit_message";

/** Only the name, so a child conversation drops the extension without the thread it was made for. */
export const RoomToolsName: Extension = defineExtension({ name: ROOM_TOOLS_EXTENSION });

export const SET_EMOJI_DESCRIPTION =
  "Add your emoji reaction to a message, or remove it. Adding a reaction that is already there, or removing one that is not, changes nothing. " +
  "The result names the post and lists its reactions now.";

export const EDIT_MESSAGE_DESCRIPTION =
  "Replace the text of one of your own posts, as Slack's edit does. The post keeps its place, its thread and its reactions, and the room shows " +
  "it with (edited) at once, with no new post and no notification. Use it to keep one post current instead of posting again: when your reply " +
  "is a checklist of what you will check or do, edit that same post as each item finishes, change `- [ ]` to `- [x]` with a short result " +
  "after the item, add or reword items when the plan changes, and put the answer in the last edit. You can edit only your own posts. " +
  "The result names the post, such as p14, so a later edit can use that id.";

export interface EditMessageArgs { message_id: string; text: string }

export interface SetEmojiArgs { message_id: string; emoji: string; on: boolean }

const text = (value: string) => [{ type: "text" as const, text: value }];

/** The room tools of one thread, which call apps/chat as that thread. */
export function roomTools(app: ChatApp, thread: string): Extension {
  return defineExtension({
    name: ROOM_TOOLS_EXTENSION,
    tools: [
      defineTool({
        name: SET_EMOJI_TOOL,
        description: SET_EMOJI_DESCRIPTION,
        parameters: Type.Object({
          message_id: Type.String({
            description: "The message: a room-qualified id such as dm_vent/p7 or ch_1a2b3c4d/p12, a post id such as p12 from a room post's header " +
              "or a room read, or the [message id: ...] value after an owner message.",
          }),
          emoji: Type.String({ description: "The emoji's Slack name, such as eyes, +1 or pray, or the emoji itself." }),
          on: Type.Boolean({ description: "true adds your reaction, false removes it." }),
        }),
        // Both directions are idempotent on the server, so a rerun after a crash leaves the same reactions.
        replay: "safe",
        execute: async (args, api, context) => {
          // A job made before its conversation dropped this extension still lists it, so the call refuses there.
          if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: text("set_emoji works only in your agent's own thread, not in a job."), isError: true };
          try {
            const answer = await app.react(thread, { message: args.message_id, emoji: args.emoji, on: args.on }, context.abortSignal);
            return { output: text(answer.text) };
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
          }
        },
      }),
      defineTool({
        name: EDIT_MESSAGE_TOOL,
        description: EDIT_MESSAGE_DESCRIPTION,
        parameters: Type.Object({
          message_id: Type.String({
            description: "Your post: its id such as p14 or a room-qualified id such as dm_vent/p14 or ch_1a2b3c4d/p14; reply:<id> for your first " +
              "post that answers that owner post, such as reply:p12, reply:dm_vent/p12 or reply: with the [message id: ...] after his message; " +
              "or last for your newest post in the room.",
          }),
          text: Type.String({ description: "The whole new text of the post, which replaces the old text." }),
        }),
        // The same text again changes nothing on the server, so a rerun after a crash leaves the same post.
        replay: "safe",
        execute: async (args, api, context) => {
          if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: text("edit_message works only in your agent's own thread, not in a job."), isError: true };
          try {
            const answer = await app.editPost(thread, { message: args.message_id, text: args.text }, context.abortSignal);
            return { output: text(answer.text) };
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
          }
        },
      }),
      ...forMeTools(app, thread),
      ...laterTools(app, thread),
      ...searchTools(app),
    ],
  });
}
