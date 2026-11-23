/**
 * A durable thread's child conversations that run beside their parent: the `rlm.child` record a parent keeps of each child it spawned, and
 * the `rlm.deliver` task that hands a child one message and hands the parent the child's notice when the run it started settles.
 *
 * The task is a background task of the parent conversation, so the parent's run ends at once, its Esc does not reach the child, and an
 * input sent to the parent meanwhile starts or joins the parent's next run instead of waiting for the child. `rlm.spawn` (`rlm.ts`) and the
 * `subagent` tool (`subagent.ts`) both start children this way.
 */
import type { Message, TextContent } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTask, ROOT_CONVERSATION_ID, type ConversationId, type Extension, type TaskId } from "@earendil-works/pi-durable";
import { dirname, join } from "node:path";
import { label, PREVIEW } from "../../../pi-rlm/src/pi/children.ts";
import { track } from "../loop-stall.ts";

/** Prime's agent id of a conversation, as apps/chat names its agents: the thread for the root, `<thread>:<conversation>` for a child. */
export const agentIdOf = (thread: string, conversation: number): string => (conversation === ROOT_CONVERSATION_ID ? thread : `${thread}:${conversation}`);
/** The session id a conversation's prompt and artifacts use (prime-prompt.ts `session`). */
export const sessionOf = (thread: string, conversation: number): string => `${thread}-${conversation}`;
/** Where a conversation's kernel snapshot and relay log live, next to the thread files; its harness store is `conversationHarnessDir`'s. */
export const artifactDirOf = (threadFile: string, thread: string, conversation: number): string =>
  join(dirname(dirname(threadFile)), "session-artifacts", sessionOf(thread, conversation));

/**
 * A wake or heartbeat for a job conversation that was removed or does not exist: `DurableThreads.submit` admits nothing, logs one line and
 * throws this, and `durable_submit` answers `{dropped}`, so apps/chat's wake ticker deletes the wake instead of trying it again on every
 * tick. On 11-20 a board.wake reached the removed job 28350de8:73, which then ran 10 min with no parent to report to.
 */
export class InputDropped extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "InputDropped";
  }
}

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
/**
 * Per thread, what resolves once a conversation's `bash()` handles and their `[bash-done]` runs are over, true when it waited
 * (`rlm.ts` `workDone`). A thread with no kernel host has none.
 */
export const childWork = new Map<string, (conversation: number, signal: AbortSignal) => Promise<boolean>>();
/**
 * Per thread, whether a conversation has a `board.wake` set that has not gone out yet (`rlm.ts` `wakePending`, read from apps/chat). A thread
 * with none never holds its children for a wake.
 */
export const childWakes = new Map<string, (conversation: number, signal: AbortSignal) => Promise<boolean>>();
/**
 * How long a child held for a wake sleeps before its wakes are read again. apps/chat's wake ticker beats every 30 s (legacy wakes.ts
 * `TICK_MS`), so a wake goes out no sooner than that.
 */
const wakePollMs = (): number => Number(process.env.PI_HOST_WAKE_POLL_MS ?? 30_000);
/**
 * How long a held child sleeps before its next wake read: a random part of one interval the first time, the whole interval after. Children
 * held at the same moment would otherwise read in step forever: on 11-22, 2,749 wake reads came to :5184 in 11 minutes in bursts of 25 to 71
 * calls within a few hundred ms, and an apps/chat hand-over that stopped inside one caught 44 fresh connections to forward.
 */
export const wakeSleepMs = (first: boolean, poll = wakePollMs(), random = Math.random): number => (first ? Math.floor(random() * poll) : poll);
/** The child a delivery task holds, when its state is in the `hold` phase. */
const heldChild = (state: unknown): number | undefined => {
  const checkpoint = (state as { checkpoint?: { phase?: string; child?: number } }).checkpoint;
  return checkpoint?.phase === "hold" ? checkpoint.child : undefined;
};
/** The statuses of a task that is not over yet (pi-durable's scheduler `LIVE_STATUSES`). */
const LIVE = ["pending", "running", "waiting", "sleeping", "completing"] as const;
const DELIVER = "rlm.deliver";

type DeliverState =
  | { phase: "deliver" }
  | { phase: "hold"; child: number; since: number; answer?: number; polled?: true }
  | { phase: "report"; child: number; since: number; status: "done" | "unanswered"; answer?: number; text: string; stopReason?: string; reason?: string; error?: string };

export const textOfMessage = (message: Message | undefined): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).flatMap(part => (part.type === "text" ? [(part as TextContent).text] : [])).join("\n");
};

/**
 * One message from a parent to a child, and the child's notice to the parent when the run it starts, the `bash()` handles that run left
 * going, the deliveries to its own children and the `board.wake`s it set, settle without a reply: a
 * background task of the parent conversation, so the parent's own runs end and its Esc does not reach the child. Its first run owns the
 * child conversation. A restart reruns a phase from its top; the request ids find the submissions it already made.
 */
export const DeliverTask = defineTask<DeliverInput, DeliverState, null>({
  name: DELIVER,
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
        if (settled.status === "done") return { status: "running", checkpoint: { phase: "hold", child: child!, since, ...(settled.answer !== undefined ? { answer: settled.answer } : {}) } };
        return {
          status: "running",
          checkpoint: {
            phase: "report", child: child!, since, status: settled.status, text: "", reason: settled.reason,
            ...(settled.detail !== undefined ? { error: typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail) } : {}),
          },
        };
      }, ctx);
    },
    // The child's run is over, but it is not done while a `bash()` handle it started runs, while the run a `[bash-done]` input or a wake
    // started goes on, while a delivery to one of its own children is going, whose reply or notice starts its next run, or while a
    // `board.wake` it set has not gone out, as Prime's `waitForRlmQuiescence` holds it. The waits for its children and its wakes are
    // durable, so they hold nothing and outlive a restart. The report then carries the newest run's last text.
    hold: async (task, runtime, ctx) => {
      const s = task.state.checkpoint;
      const handle = await runtime.conversation(s.child as ConversationId, ctx);
      const doc = await runtime.snapshot(RlmChildDoc, s.child as ConversationId, ctx);
      if (handle && !doc?.deleted) {
        do await handle.waitForIdle(ctx);
        while (await childWork.get(task.input.thread)?.(s.child, runtime.signal));
        const { subagents, holder } = await track("rlm.deliver hold", sessionOf(task.input.thread, s.child), () => new Promise<{ subagents: TaskId[]; holder?: TaskId }>((resolve, reject) => void runtime.commit(async tx => {
          const live: TaskId[] = [];
          let holder: TaskId | undefined;
          // One scan per status over the whole file, filtered here: a scan that also names the conversation and kind makes SQLite walk
          // every task of that conversation, and a thread root's 5,640 tasks took 14 to 80 ms per scan, ten scans per hold, on 11-23
          // (~/work/pi-host-stalls/h-restart-resume/report.md). The few tasks not over yet sit in the status index.
          for (const status of LIVE) {
            let cursor: Parameters<typeof tx.scanTasks>[2];
            do {
              const page = await tx.scanTasks({ status }, 500, cursor);
              for (const t of page.items) {
                if (t.kind !== DELIVER) continue;
                if (t.conversationId === s.child && (t.input as DeliverInput).parent === s.child) live.push(t.id);
                if (t.conversationId === task.input.parent && t.id < runtime.taskId && (holder === undefined || t.id < holder) && heldChild(t.state) === s.child) holder = t.id;
              }
              cursor = page.next;
            } while (cursor !== undefined);
          }
          resolve({ subagents: live, ...(holder === undefined ? {} : { holder }) });
          return undefined;
        }, ctx).catch(reject)));
        if (subagents.length) {
          await runtime.commit(() => ({ status: "waiting", checkpoint: s, on: subagents, policy: "allSettled" }), ctx);
          return;
        }
        // An older delivery to the same child holds it for the same handles, subagents and wakes, so this one waits for that one to end
        // instead of reading the wakes too. On 11-22, 160 held deliveries were for 14 children, one child had 36, and the
        // 123 that slept read :5184's wakes every 30 s each, about 4 reads a second.
        if (holder !== undefined) {
          await runtime.commit(() => ({ status: "waiting", checkpoint: s, on: [holder], policy: "allSettled" }), ctx);
          return;
        }
        const waking = await childWakes.get(task.input.thread)?.(s.child, runtime.signal);
        if (waking) {
          await runtime.sleepUntil(runtime.now() + wakeSleepMs(!s.polled), { ...s, polled: true }, ctx);
          return;
        }
      }
      const answer = (await runtime.context(s.child as ConversationId, ctx)).messages.findLast(message => message.role === "assistant") as
        (Message & { stopReason?: string; errorMessage?: string }) | undefined;
      await runtime.commit(() => ({
        status: "running",
        checkpoint: {
          phase: "report", child: s.child, since: s.since, status: "done", text: textOfMessage(answer),
          ...(s.answer !== undefined ? { answer: s.answer } : {}),
          ...(answer?.stopReason ? { stopReason: answer.stopReason } : {}),
          ...(answer?.stopReason === "error" ? { error: answer.errorMessage ?? "the child's last model call failed" } : {}),
        },
      }), ctx);
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
