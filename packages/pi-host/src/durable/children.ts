/**
 * A durable thread's child conversations that run beside their parent: the `rlm.child` record a parent keeps of each child it spawned, and
 * the `rlm.deliver` task that hands a child one message and hands the parent the child's notice when the run it started settles.
 *
 * The task is a background task of the parent conversation, so the parent's run ends at once, its Esc does not reach the child, and an
 * input sent to the parent meanwhile starts or joins the parent's next run instead of waiting for the child. `rlm.spawn` (`rlm.ts`) and the
 * `subagent` tool (`subagent.ts`) both start children this way.
 */
import type { Message, TextContent } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTask, ROOT_CONVERSATION_ID, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { dirname, join } from "node:path";
import { label, PREVIEW } from "../../../pi-rlm/src/pi/children.ts";

/** Prime's agent id of a conversation, as apps/chat names its agents: the thread for the root, `<thread>:<conversation>` for a child. */
export const agentIdOf = (thread: string, conversation: number): string => (conversation === ROOT_CONVERSATION_ID ? thread : `${thread}:${conversation}`);
/** The session id a conversation's prompt and artifacts use (prime-prompt.ts `session`). */
export const sessionOf = (thread: string, conversation: number): string => `${thread}-${conversation}`;
/** Where a conversation's kernel snapshot, relay log and local harness store live, next to the thread files as `threadHarnessDir` puts them. */
export const artifactDirOf = (threadFile: string, thread: string, conversation: number): string =>
  join(dirname(dirname(threadFile)), "session-artifacts", sessionOf(thread, conversation));

// ---------------------------------------------------------------------------------------------------------------------------
// The family, kept in the thread file.

/** What a parent keeps about a child it spawned, as a document of the child conversation. */
export type RlmChild = {
  id: string;
  name: string;
  task: string;
  model: string;
  thinking: string;
  sessionDir: string;
  createdAt: number;
  /** The newest time the child sent its parent an agent message, so its run's end sends no no-reply notice. */
  repliedAt: number;
  status: "running" | "done" | "error" | "cancelled";
  endedAt: number;
  answerPreview: string;
  error: string;
  progressNote: string;
  progressAt: number;
  deleted: boolean;
};

export const RlmChildDoc = defineDoc<RlmChild>({
  kind: "rlm.child",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ id: "", name: "", task: "", model: "", thinking: "", sessionDir: "", createdAt: 0, repliedAt: 0, status: "running", endedAt: 0, answerPreview: "", error: "", progressNote: "", progressAt: 0, deleted: false }),
  checkpointWhen: () => true,
});

export type DeliverInput = {
  /** The conversation that gets the child's notice: the parent. */
  parent: number;
  /** The child; absent for a spawn, whose child is the conversation this task owns. */
  child?: number;
  thread: string;
  name: string;
  content: string;
  from: string;
  via: string;
  requestId: string;
  whenBusy: "steer" | "followUp";
  /**
   * `prime`: pi-rlm's notices, `[child-exited: no-reply child:<name>]` with the first 2,000 characters of the child's last text, and none
   * when the child replied itself. `answer`: the `subagent` tool's, the child's whole last text as `[subagent-answer child:<name>]`.
   */
  report?: "prime" | "answer";
};
type DeliverState =
  | { phase: "deliver" }
  | { phase: "report"; child: number; since: number; status: "done" | "unanswered"; answer?: number; text: string; stopReason?: string; reason?: string; error?: string };

export const textOfMessage = (message: Message | undefined): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).flatMap(part => (part.type === "text" ? [(part as TextContent).text] : [])).join("\n");
};

/**
 * One message from a parent to a child, and the child's notice to the parent when the run it starts settles without a reply: a
 * background task of the parent conversation, so the parent's own runs end and its Esc does not reach the child. Its first run owns the
 * child conversation. A restart reruns a phase from its top; the request ids find the submissions it already made.
 */
export const DeliverTask = defineTask<DeliverInput, DeliverState, null>({
  name: "rlm.deliver",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, ctx) => {
      const since = await runtime.memo<number>("since", runtime.now(), ctx);
      let child = task.input.child;
      if (child === undefined) {
        child = await new Promise<number | undefined>(resolve => void runtime.commit(async tx => {
          resolve((await tx.scanConversations({ ownerTaskId: runtime.taskId }, 1)).items[0]?.id);
          return undefined;
        }, ctx).catch(() => resolve(undefined)));
      }
      const handle = child === undefined ? undefined : await runtime.conversation(child as ConversationId, ctx);
      if (child === undefined || !handle) {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
        return;
      }
      const submission = await handle.submit({
        type: "input", content: task.input.content, requestId: task.input.requestId, whenBusy: task.input.whenBusy,
        entry: { kind: "agent.message", data: { from: task.input.from, via: task.input.via } },
      }, ctx);
      const settled = await submission.wait(ctx);
      await runtime.commit(async tx => {
        const answer = settled.status === "done" && settled.answer !== undefined ? (await tx.entry(settled.answer))?.model?.[0] as (Message & { stopReason?: string; errorMessage?: string }) | undefined : undefined;
        return {
          status: "running",
          checkpoint: {
            phase: "report", child: child!, since, status: settled.status, text: textOfMessage(answer),
            ...(settled.status === "done" ? { answer: settled.answer } : { reason: settled.reason }),
            ...(answer?.stopReason ? { stopReason: answer.stopReason } : {}),
            ...(answer?.stopReason === "error" ? { error: answer.errorMessage ?? "the child's last model call failed" } : {}),
            ...(settled.status === "unanswered" && settled.detail !== undefined ? { error: typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail) } : {}),
          },
        };
      }, ctx);
    },
    report: async (task, runtime, ctx) => {
      const s = task.state.checkpoint;
      const doc = await runtime.snapshot(RlmChildDoc, s.child as ConversationId, ctx);
      const cancelled = s.status === "unanswered" && /abort|withdraw/i.test(s.reason ?? "");
      const failed = !cancelled && (s.status === "unanswered" || s.stopReason === "error");
      const status: RlmChild["status"] = cancelled ? "cancelled" : failed ? "error" : "done";
      const error = failed ? s.error || s.reason || "the child's run ended without an answer" : "";
      const name = label(doc?.name || task.input.name);
      let notice: string | undefined;
      if (doc?.deleted) notice = undefined;
      else if (failed) notice = `[child-failed child:${name}]\n\n${error}`;
      else if (task.input.report === "answer") notice = `[subagent-answer child:${name}]\n\n${s.text}`;
      else if ((doc?.repliedAt ?? 0) < s.since) notice = `[child-exited: ${cancelled ? "cancelled" : "no-reply"} child:${name}]${s.text ? `\n\nLast assistant text: ${s.text.slice(0, PREVIEW)}` : ""}`;
      if (notice) {
        const parent = await runtime.conversation(task.input.parent as ConversationId, ctx);
        await parent?.submit({
          type: "input", content: notice, requestId: `rlm-notice:${s.child}:${s.answer ?? runtime.taskId}`, whenBusy: "steer",
          entry: { kind: "agent.message", data: { from: agentIdOf(task.input.thread, s.child), via: "rlm.child" } },
        }, ctx);
      }
      await runtime.commit(async tx => {
        const draft = await tx.doc(RlmChildDoc, s.child as ConversationId);
        if (!draft.deleted) Object.assign(draft, { status, endedAt: runtime.now(), answerPreview: s.text.slice(0, PREVIEW), error });
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, ctx);
    },
  },
  abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** The extension that installs the delivery task, which every conversation of a thread keeps, children too. */
export const ChildTasks: Extension = defineExtension({ name: "rlm-tasks", tasks: [DeliverTask] });
