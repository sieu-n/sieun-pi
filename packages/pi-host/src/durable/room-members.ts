/**
 * `set_room_member` adds a registered agent to a channel or Solo room, or takes it out, through apps/chat's `POST /api/threads/:thread/members`
 * (app.ts `memberAsAgent`), as the owner asked on 11-22 in #sw-factory-build (p142): "ui에서 add/remove 이런거 할수 있어야됨". An added
 * agent hears every post there and gets its comm thread for the room at once; a removed one hears only posts that @mention it. The room
 * shows each change as a system line that names the agent who made it. Adding a member twice or removing a non-member changes nothing.
 *
 * `roomMemberTools` returns the definition, which the `room-tools` extension lists beside `set_emoji` (`room-tools.ts`), so a job's child
 * conversation drops it with them.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ChatApp } from "./chat-app.ts";

export const SET_ROOM_MEMBER_TOOL = "set_room_member";

export const SET_ROOM_MEMBER_DESCRIPTION =
  "Add an agent to a channel or Solo room, or remove it, when the owner asks you to. A member hears every post in the room; a removed agent " +
  "hears only posts that @mention it, and its earlier posts stay. The room shows the change as a line such as \"Vent added Crawler VP\". " +
  "Adding a member twice or removing a non-member changes nothing. The owner is in every room and is never removed.";

const text = (value: string) => [{ type: "text" as const, text: value }];

/** The room member tool of one thread, which calls apps/chat as that thread. */
export function roomMemberTools(app: ChatApp, thread: string) {
  return [
    defineTool({
      name: SET_ROOM_MEMBER_TOOL,
      description: SET_ROOM_MEMBER_DESCRIPTION,
      parameters: Type.Object({
        room: Type.String({ description: "The channel or Solo room: its id such as ch_1a2b3c4d or so_1a2b3c4d, or a channel's name such as #general." }),
        agent: Type.String({ description: "The registered agent: its id such as ag_vent, or its name such as Crawler VP." }),
        member: Type.Boolean({ description: "true adds the agent to the room, false removes it." }),
      }),
      // The server adds and removes idempotently, so a rerun after a crash leaves the same members.
      replay: "safe",
      execute: async (args, api, context) => {
        // A job made before its conversation dropped this extension still lists it, so the call refuses there.
        if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: text(`${SET_ROOM_MEMBER_TOOL} works only in your agent's own thread, not in a job.`), isError: true };
        try {
          const answer = await app.roomMember(thread, { room: args.room, agent: args.agent, member: args.member }, context.abortSignal);
          return { output: text(answer.text) };
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
        }
      },
    }),
  ];
}
