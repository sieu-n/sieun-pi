import type { Context } from "@earendil-works/chord";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineExtension, defineTool, type ConversationId, type EntryId, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { randomBytes } from "node:crypto";
import { dropAgentRole } from "./agent-profile.ts";
import { agentIdOf, artifactDirOf, DeliverTask, RlmChildDoc } from "./children.ts";
import { jobTitle } from "./job-title.ts";
import { PrimeChatName } from "./prime-chat.ts";
import { SendMessage } from "./send-message.ts";

async function answerText(api: ToolExecutionApi, answer: EntryId, context: Context): Promise<string> {
  const entry = await api.commit(tx => tx.entry(AssistantEntry, answer), context);
  const reply = entry?.model?.[0] as AssistantMessage | undefined;
  return (reply?.content ?? []).flatMap(c => (c.type === "text" ? [c.text] : [])).join("");
}

export const SUBAGENT_STARTED = "Started the subagent. Its answer arrives as a new message when it ends; end your turn now unless other work is left.";

/** Only the name, so a child conversation drops the tool without the thread it was made for. */
export const Subagent: Extension = defineExtension({ name: "subagent" });

/**
 * The subagent tool: the call starts a child conversation and returns at once, as Prime's `rlm.spawn` does, and the child's whole answer
 * reaches the parent later as an agent message input (`[subagent-answer child:<name>]`), from the `rlm.deliver` task of `children.ts`. The
 * parent's run ends meanwhile, so an owner message or a steer sent while the child works starts or joins the parent's next run.
 *
 * A call made before this change owns its child and waits for its answer; a rerun of such a call after a restart still does, so the
 * answer it waited for lands once. The child answers with its final text, so it gets no `send_message` and none of the chat's tools.
 */
export function subagentExtension(thread: { id: string; file?: string }): Extension {
  return defineExtension({
    name: "subagent",
    tools: [
      defineTool({
        name: "subagent",
        description: "Delegate a self-contained task to a subagent. The call returns at once; the subagent's answer arrives later as a new message.",
        parameters: Type.Object({
          task: Type.String({ description: "What the subagent should do" }),
          name: Type.Optional(Type.String({ description: "A short title for the subagent, a few words, shown in the owner's lists" })),
        }),
        // A rerun after a crash would start a second child, so a cut-off call ends `interrupted`; a call from before this change kept "safe".
        replay: "unsafe",
        execute: async (args, api, context) => {
          const owned = await api.commit(async tx => (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]?.id, context);
          if (owned !== undefined) return foreground(api, owned, args.task, context);
          const name = args.name?.trim() || jobTitle(args.task) || "subagent";
          const child = await api.commit(async tx => {
            const task = await tx.createTask(DeliverTask, {
              parent: api.conversationId, thread: thread.id, name, content: args.task, from: agentIdOf(thread.id, api.conversationId),
              via: "subagent", requestId: `subagent:${api.taskId}`, whenBusy: "steer", report: "answer",
            }, { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true });
            const created = await tx.createConversation({ ownership: { kind: "task", taskId: task } });
            await configure(tx, created.id, { extensions: { remove: [Subagent, SendMessage, PrimeChatName] } });
            await dropAgentRole(tx, created.id);
            Object.assign(await tx.doc(RlmChildDoc, created.id), {
              id: `sub-${randomBytes(4).toString("hex")}`, name, task: args.task, sessionDir: thread.file ? artifactDirOf(thread.file, thread.id, created.id) : "",
              createdAt: Date.now(), status: "running",
            });
            return created.id;
          }, context);
          return { output: [{ type: "text", text: SUBAGENT_STARTED }], details: { conversationId: child } };
        },
      }),
    ],
  });
}

/** The old foreground call: submit the task to the child it owns and return the child's answer. */
async function foreground(api: ToolExecutionApi, child: ConversationId, task: string, context: Context) {
  await api.details({ conversationId: child }, context);
  const handle = await api.conversation(child, context);
  if (handle === undefined) throw new Error(`Subagent conversation ${child} is gone`);
  const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
  const settled = await (await handle.submit(request, context)).wait(context);
  if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent ended ${settled.status}`);
  const text = await answerText(api, settled.answer, context);
  return { output: [{ type: "text" as const, text }], details: { conversationId: child } };
}

/**
 * The foreground subagent of `openDurableHost` (the one-file durable host the crash tests drive): the call owns its child, submits the task
 * there and returns the child's answer. It is replay-safe, because a rerun after a crash finds the child through the ownership index and
 * the child's submission through its request id.
 */
export const ForegroundSubagent: Extension = defineExtension({
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
        return foreground(api, child, args.task, context);
      },
    }),
  ],
});
