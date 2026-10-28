import type { Context } from "@earendil-works/chord";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineExtension, defineTool, type EntryId, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { PrimeChatName } from "./prime-chat.ts";
import { SendMessage } from "./send-message.ts";

async function answerText(api: ToolExecutionApi, answer: EntryId, context: Context): Promise<string> {
  const entry = await api.commit(tx => tx.entry(AssistantEntry, answer), context);
  const reply = entry?.model?.[0] as AssistantMessage | undefined;
  return (reply?.content ?? []).flatMap(c => (c.type === "text" ? [c.text] : [])).join("");
}

/**
 * A foreground subagent: the tool call creates a child conversation it owns, submits the task there and returns the
 * child's answer. It is replay-safe, because a rerun after a crash finds the child through the ownership index and the
 * child's submission through its request id, so the child is made once and asked once. The child answers its parent with its
 * final text, so it gets no `send_message` and none of the chat's tools (`prime-chat`), as a Prime chat's job has no tell_owner.
 */
export const Subagent: Extension = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "subagent",
      description: "Delegate a self-contained task to a subagent and get its answer back.",
      parameters: Type.Object({ task: Type.String({ description: "What the subagent should do" }) }),
      replay: "safe",
      execute: async (args, api, context) => {
        const child = await api.commit(async tx => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== undefined) return existing.id;
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          await configure(tx, created.id, { extensions: { remove: [Subagent, SendMessage, PrimeChatName] } });
          return created.id;
        }, context);
        await api.details({ conversationId: child }, context);
        const handle = await api.conversation(child, context);
        if (handle === undefined) throw new Error(`Subagent conversation ${child} is gone`);
        const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
        const settled = await (await handle.submit(request, context)).wait(context);
        if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent ended ${settled.status}`);
        const text = await answerText(api, settled.answer, context);
        return { output: [{ type: "text", text }], details: { conversationId: child } };
      },
    }),
  ],
});
