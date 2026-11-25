/**
 * `read_post`: an agent reads one post and its thread by the post's id, through apps/chat's `GET /api/threads/:thread/post`
 * (app.ts `readAsAgent`, later-agents.ts `read`). On 11-25 fable auditor read its own reply with a keyword search_messages, because no tool
 * read a post by its id (ch_14ad7a70/p224, owner c245).
 *
 * It takes the one message id every room tool takes (`MESSAGE_ID` in later.ts). The room-tools extension lists it beside `set_emoji`
 * (`room-tools.ts`), so a job's child conversation drops it with the others. Reading changes nothing, so a rerun after a crash is safe.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ChatApp } from "./chat-app.ts";
import { MESSAGE_ID } from "./later.ts";

export const READ_POST_TOOL = "read_post";

export const READ_POST_DESCRIPTION =
  "Read one post by its id, whole, with its room, author, time, reactions and your save, then the thread it sits in: the root and its " +
  "replies, the newest 12 of a long one. Use it to read your own post or reply back, or a post someone named, instead of searching for its words.";

const text = (value: string) => [{ type: "text" as const, text: value }];

/** The read_post tool of one thread, which reads apps/chat as that thread. */
export function readPostTools(app: ChatApp, thread: string) {
  return [
    defineTool({
      name: READ_POST_TOOL,
      description: READ_POST_DESCRIPTION,
      parameters: Type.Object({ message_id: MESSAGE_ID }),
      replay: "safe",
      execute: async (args, api, context) => {
        // A job made before its conversation dropped this extension still lists it, so the call refuses there.
        if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: text(`${READ_POST_TOOL} works only in your agent's own thread, not in a job.`), isError: true };
        try {
          return { output: text((await app.readPost(thread, args.message_id, context.abortSignal)).text) };
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
        }
      },
    }),
  ];
}
