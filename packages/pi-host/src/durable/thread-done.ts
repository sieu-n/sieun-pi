/**
 * The done flag of a room thread, as the owner asked on 11-20 in #sw-factory-build (p113): "끝난 쓰레드를 Check로 살짝 흐릿하게 만들수
 * 있으면 좋겠다. make it a boolean flag that applies to the root thread message, and view/editable by agent too".
 *
 * `set_thread_done` marks the thread of a post done or open again through apps/chat's `POST /api/threads/:thread/done`
 * (apps/chat/server/thread-done.ts), which puts the flag on the thread's root post and answers with the line the tool returns. The room
 * shows a done root with a check and dimmed, and a new owner reply in the thread reopens it. Agents read the flag as `[thread done by X]`
 * next to a post's reactions. Only the comm role text asks an agent to set it (`agent-profile.ts`); no code sets it for the agent (c210).
 *
 * `threadDoneTools` returns the definition, which the `room-tools` extension lists beside `set_emoji` (`room-tools.ts`), so a job's child
 * conversation drops it with them.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ChatApp } from "./chat-app.ts";

export const SET_THREAD_DONE_TOOL = "set_thread_done";

export const SET_THREAD_DONE_DESCRIPTION =
  "Mark a thread done, or open again, as a resolved thread in Slack. The flag goes on the thread's root post, whichever post of the thread " +
  "you name, and the room shows a done thread with a check and dimmed. A new reply from the owner in a done thread reopens it. Marking it " +
  "the same way twice changes nothing. The result names the root post.";

const text = (value: string) => [{ type: "text" as const, text: value }];

/** The thread done tool of one thread, which calls apps/chat as that thread. */
export function threadDoneTools(app: ChatApp, thread: string) {
  return [
    defineTool({
      name: SET_THREAD_DONE_TOOL,
      description: SET_THREAD_DONE_DESCRIPTION,
      parameters: Type.Object({
        message_id: Type.String({
          description: "Any post of the thread: a room-qualified id such as dm_vent/p7 or ch_1a2b3c4d/p12, a post id such as p12 from a room " +
            "post's header or a room read, or the [message id: ...] value after an owner message.",
        }),
        done: Type.Boolean({ description: "true marks the thread done, false opens it again." }),
      }),
      // The server sets the flag idempotently, so a rerun after a crash leaves the same flag.
      replay: "safe",
      execute: async (args, api, context) => {
        // A job made before its conversation dropped this extension still lists it, so the call refuses there.
        if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: text(`${SET_THREAD_DONE_TOOL} works only in your agent's own thread, not in a job.`), isError: true };
        try {
          return { output: text((await app.threadDone(thread, { message: args.message_id, done: args.done }, context.abortSignal)).text) };
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
        }
      },
    }),
  ];
}
