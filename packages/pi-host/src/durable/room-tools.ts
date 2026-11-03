/**
 * Tools an agent uses on the posts of its rooms, through apps/chat's HTTP API (`chat-app.ts`). One extension, `room-tools`, which a thread's
 * root conversation runs when the host loaded Prime's chat extension; a job's child conversation drops it by name (`RoomToolsName`), as it
 * drops the chat's own tools.
 *
 * `set_emoji` puts the agent's reaction on a post or takes it off, as Slack's `reactions.add` and `reactions.remove` do. The comm role text
 * asks the agent to mark the post it works on with 👀 and take it off with the result (`agent-profile.ts`); no code here treats an emoji
 * specially (contract: /home/sieun/work/slack-reactions/contract.md).
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, ROOT_CONVERSATION_ID, type Extension } from "@earendil-works/pi-durable";
import type { ChatApp } from "./chat-app.ts";

export const ROOM_TOOLS_EXTENSION = "room-tools";
export const SET_EMOJI_TOOL = "set_emoji";

/** Only the name, so a child conversation drops the extension without the thread it was made for. */
export const RoomToolsName: Extension = defineExtension({ name: ROOM_TOOLS_EXTENSION });

export const SET_EMOJI_DESCRIPTION =
  "Add your emoji reaction to a message, or remove it. Adding a reaction that is already there, or removing one that is not, changes nothing. " +
  "The result names the post and lists its reactions now.";

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
          emoji: Type.String({ description: "The emoji's Slack name, such as eyes, white_check_mark or +1, or the emoji itself." }),
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
    ],
  });
}
