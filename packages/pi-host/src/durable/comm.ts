/**
 * A comm thread's link to its agent's work thread (`apps/chat/docs/agent-model.md`, phase 4): the `comm.hand` task that hands the work
 * thread one task and sends the comm thread pi-host's work-done notice when it settles, and the `stop_work` tool.
 *
 * A comm thread hands work over with Prime's `agent_message.send(task, receiver_role="sibling", receiver_name=<work thread>)`. pi-host
 * (`DurableThreads`) turns that send into a background `comm.hand` task of the comm thread's root conversation, which admits the task to
 * the work thread, waits across threads for that input to settle, and then submits the notice to the comm thread, as pi-rlm's ChildManager
 * does for a child (`children.ts` `rlm.deliver`):
 *
 * 1. `[work-done: no-reply agent:<work name>]` with the first 2,000 characters of the work thread's last text, when the work thread sent the
 *    comm thread no agent message since the task started.
 * 2. `[work-done: cancelled agent:<work name>]` when the input was aborted, such as by `stop_work`, under the same condition.
 * 3. `[work-failed agent:<work name>]` with the error whenever the input failed, as Prime's `[child-failed ...]` goes out even after a reply.
 *
 * The task is durable, so a pi-host restart resumes it at its phase, and the request ids (the hand-over's own, and `n:<work>:<submission>`
 * for the notice) keep each input once. `stop_work` aborts the work thread's root conversation; it is a deferred tool that only a comm
 * thread's agent loads (`agent-profile.ts` `roleFields`).
 */
import type { Context } from "@earendil-works/chord";
import { Type, type Message } from "@earendil-works/pi-ai";
import {
  defineDoc, defineExtension, defineTask, defineTool, ROOT_CONVERSATION_ID, type Extension, type SettledSubmissionRecord, type SubmissionId, type Task, type Tx,
} from "@earendil-works/pi-durable";
import { label, PREVIEW } from "../../../pi-rlm/src/pi/children.ts";
import { STOP_WORK_TOOL, threadAgent } from "./agent-profile.ts";
import { textOfMessage } from "./children.ts";

/** An agent message one thread sends another, as pi-host admits it. */
export interface CommSubmit {
  text: string;
  requestId: string;
  whenBusy: "steer" | "followUp";
  entry: { kind: "agent.message"; data: { from: string; via: string } };
}

/** What the comm side needs of pi-host's other threads; `DurableThreads` passes one per thread file. */
export interface CommHost {
  /** The thread this extension serves. */
  thread: string;
  submit(thread: string, input: CommSubmit): Promise<{ submission: SubmissionId }>;
  wait(thread: string, submission: SubmissionId, context: Context): Promise<SettledSubmissionRecord>;
  /** A settled input's answer entry in `thread`, as its message. */
  answer(thread: string, entry: number): Promise<Message | undefined>;
  name(thread: string): string;
  abort(thread: string): Promise<void>;
  /** Whether pi-host is shutting down, when a call to another thread fails because its file closed and the task must wait for the restart. */
  closing(): boolean;
}

/** How many agent messages each thread has sent this comm thread, by sender thread id; the hand-over compares it before and after. */
export const CommHeardDoc = defineDoc<{ from: Record<string, number> }>({
  kind: "comm.heard",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ from: {} }),
  checkpointWhen: () => true,
});

/** Counts one agent message from `from` in the comm thread's root, after its admission. */
export async function noteHeard(tx: Tx, from: string): Promise<void> {
  const doc = await tx.doc(CommHeardDoc, ROOT_CONVERSATION_ID);
  doc.from[from] = (doc.from[from] ?? 0) + 1;
}

export type HandInput = { work: string } & CommSubmit;
type HandState =
  | { phase: "deliver" }
  | { phase: "wait"; submission: SubmissionId; heard: number }
  | { phase: "report"; submission?: SubmissionId; heard: number; status: "done" | "unanswered"; text: string; reason?: string; error?: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Runs a call to another thread. While pi-host shuts down, that thread's file may close first, so the failure holds the phase until its own
 * harness closes and the restart reruns it; any other failure comes back as the error text.
 */
async function across<T>(host: CommHost, signal: AbortSignal, run: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    if (!host.closing() && !signal.aborted) return { error: messageOf(error) };
    await new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    throw error;
  }
}

export const HAND_TASK = "comm.hand";

/** The notice a settled hand-over sends the comm thread, or none when the work thread already wrote back. */
export function workNotice(name: string, s: { status: "done" | "unanswered"; text: string; reason?: string; error?: string }, replied: boolean): string | undefined {
  const who = `agent:${label(name)}`;
  const cancelled = s.status === "unanswered" && /abort|withdraw/i.test(s.reason ?? "");
  if (!cancelled && (s.status === "unanswered" || s.error)) return `[work-failed ${who}]\n\n${s.error || s.reason || "the work thread's run ended without an answer"}`;
  if (replied) return undefined;
  if (cancelled) return `[work-done: cancelled ${who}]`;
  return `[work-done: no-reply ${who}]${s.text ? `\n\nLast assistant text: ${s.text.slice(0, PREVIEW)}` : ""}`;
}

function handTask(host: CommHost): Task<HandInput, HandState, null, object> {
  return defineTask<HandInput, HandState, null>({
    name: HAND_TASK,
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const { work, text, requestId, whenBusy, entry } = task.input;
        const heard = await runtime.memo<number>("heard", (await runtime.snapshot(CommHeardDoc, ROOT_CONVERSATION_ID, ctx))?.from[work] ?? 0, ctx);
        const sent = await across(host, runtime.signal, () => host.submit(work, { text, requestId, whenBusy, entry }));
        await runtime.commit(() => ({
          status: "running",
          checkpoint: "value" in sent ? { phase: "wait", submission: sent.value.submission, heard } : { phase: "report", heard, status: "unanswered", text: "", error: sent.error },
        }), ctx);
      },
      wait: async (task, runtime, ctx) => {
        const s = task.state.checkpoint;
        const waited = await across(host, runtime.signal, () => host.wait(task.input.work, s.submission, ctx));
        if ("error" in waited) {
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", submission: s.submission, heard: s.heard, status: "unanswered", text: "", error: waited.error } }), ctx);
          return;
        }
        const settled = waited.value;
        const answer = settled.status === "done" ? await host.answer(task.input.work, settled.answer as number) as (Message & { stopReason?: string; errorMessage?: string }) | undefined : undefined;
        const error = answer?.stopReason === "error" ? answer.errorMessage ?? "the work thread's last model call failed"
          : settled.status === "unanswered" && settled.detail !== undefined ? (typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)) : undefined;
        await runtime.commit(() => ({
          status: "running",
          checkpoint: {
            phase: "report", submission: s.submission, heard: s.heard, status: settled.status, text: textOfMessage(answer),
            ...(settled.status === "unanswered" ? { reason: settled.reason } : {}), ...(error ? { error } : {}),
          },
        }), ctx);
      },
      report: async (task, runtime, ctx) => {
        const s = task.state.checkpoint;
        const work = task.input.work;
        const heard = (await runtime.snapshot(CommHeardDoc, ROOT_CONVERSATION_ID, ctx))?.from[work] ?? 0;
        const notice = workNotice(host.name(work), s, heard > s.heard);
        if (notice) {
          const sent = await across(host, runtime.signal, () => host.submit(host.thread, {
            text: notice, requestId: `n:${work}:${s.submission ?? `task-${runtime.taskId}`}`, whenBusy: "steer", entry: { kind: "agent.message", data: { from: work, via: "work.done" } },
          }));
          if ("error" in sent) runtime.report(new Error(`the work-done notice was not admitted: ${sent.error}`));
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
}

/** The comm extension of one thread file: the hand-over task, which any thread may run, and `stop_work`, which only a comm thread loads. */
export function commExtension(host: CommHost): { extension: Extension; hand: Task<HandInput, HandState, null, object> } {
  const hand = handTask(host);
  const stopWork = defineTool({
    name: STOP_WORK_TOOL,
    description: "Stop the turn your agent's work thread is running now and drop the inputs queued for it. Its subagents keep running. " +
      "Use it when the owner asks to stop the work, or the work thread is doing the wrong thing; to change course, send it a steer instead.",
    parameters: Type.Object({}),
    deferred: true,
    // An abort of an idle conversation does nothing, so a rerun after a crash is harmless.
    replay: "safe",
    execute: async (_args, api, context) => {
      const ref = await threadAgent(api, context);
      if (ref?.role !== "comm") return { output: [{ type: "text", text: "stop_work works only in a comm thread." }], isError: true };
      await host.abort(ref.work);
      return { output: [{ type: "text", text: `Stopped the work thread ${ref.work}.` }] };
    },
  });
  return { extension: defineExtension({ name: "comm", tools: [stopWork], tasks: [hand] }), hand };
}
