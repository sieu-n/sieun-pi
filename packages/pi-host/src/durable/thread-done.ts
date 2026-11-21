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
 *
 * Marking a thread done holds once when the turn's newest tell_owner did not go out (`heldAnswer`), and the same call again goes through (c98).
 * On 11-21 a blind run's comm thread called tell_owner and set_thread_done in one round, tell_owner held the answer as long, and the room
 * showed the question's thread done with no answer in it. A call in the round makes the round run in order, so it reads that round's post.
 */
import type { Context } from "@earendil-works/chord";
import { Type, type Message } from "@earendil-works/pi-ai";
import { defineTool, ROOT_CONVERSATION_ID, type Cursor, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ChatApp } from "./chat-app.ts";
import { closingControl } from "./for-me.ts";

export const SET_THREAD_DONE_TOOL = "set_thread_done";

export const SET_THREAD_DONE_DESCRIPTION =
  "Mark a thread done, or open again, as a resolved thread in Slack. The flag goes on the thread's root post, whichever post of the thread " +
  "you name, and the room shows a done thread with a check and dimmed. A new reply from the owner in a done thread reopens it. Marking it " +
  "the same way twice changes nothing. The result names the root post.";

const text = (value: string) => [{ type: "text" as const, text: value }];

export const HELD_DONE_MARK = "Not marked done, your answer in this turn did not go out";
/** The text tell_owner answers with when it keeps a post as a note (legacy chat-feed.ts `TELL_OWNER_HELD`). */
const KEPT_AS_NOTE = "Kept as a note, not sent";
/** The entry kinds that start a turn: an owner post or notice, and an agent message. */
const TURN_INPUTS = new Set(["pi.user", "agent.message"]);

/**
 * Whether the newest tell_owner of this turn that has a result did not go out: tell_owner refused it, as a long text, or kept it as a note.
 * Read newest first back to the turn's input; a tell_owner that went out after a held one clears it.
 */
export async function heldAnswer(api: Pick<ToolExecutionApi, "commit" | "conversationId">, context: Context): Promise<boolean> {
  return api.commit(async tx => {
    const results = new Map<string, boolean>();
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 100, cursor);
      for (const entry of page.items) {
        if (TURN_INPUTS.has(entry.kind)) return false;
        for (const message of (entry.model ?? []) as Message[]) {
          if (message.role === "toolResult" && message.toolName === "tell_owner") {
            const said = message.content.map(part => part.type === "text" ? part.text : "").join("");
            results.set(message.toolCallId, !message.isError && !said.startsWith(KEPT_AS_NOTE));
          }
          if (message.role !== "assistant") continue;
          const told = message.content.findLast(part => part.type === "toolCall" && part.name === "tell_owner" && results.has(part.id));
          if (told?.type === "toolCall") return !results.get(told.id);
        }
      }
      if (!page.next) return false;
      cursor = page.next;
    }
  }, context);
}

/** The thread done tool of one thread, which calls apps/chat as that thread. */
export function threadDoneTools(app: ChatApp, thread: string) {
  const held = new Set<string>();
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
      // A round with this call runs in order, so a tell_owner before it in the round has its result when `heldAnswer` reads.
      executionMode: "sequential",
      execute: async (args, api, context) => {
        // A job made before its conversation dropped this extension still lists it, so the call refuses there.
        if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: text(`${SET_THREAD_DONE_TOOL} works only in your agent's own thread, not in a job.`), isError: true };
        if (args.done && !held.has(args.message_id) && await heldAnswer(api, context)) {
          held.add(args.message_id);
          return { output: text(`${HELD_DONE_MARK}, so the thread would show done with no answer in it. Send the answer first, then mark the ` +
            "thread done. If the thread needs no answer, call set_thread_done again with the same post and it goes through (c98)."), isError: true };
        }
        try {
          const answer = await app.threadDone(thread, { message: args.message_id, done: args.done }, context.abortSignal);
          return { output: text(answer.text), ...await closingControl(args.done, api, context) };
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
        }
      },
    }),
  ];
}
