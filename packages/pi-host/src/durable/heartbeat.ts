/**
 * The `rlm_heartbeat` Python skill in a durable thread: agent-owned recurring prompts, kept by pi-host's `Scheduler` as Prime's daemon keeps
 * them, and answered by the same `rlmHeartbeatHandler` a pi session uses.
 *
 * The scheduler reaches a session through a `SessionHandle`. A durable conversation gets one at its first `rlm_heartbeat.*` request and keeps
 * it while its thread is open: it reports the conversation busy from a cell until the run settles, and it sends a due heartbeat as an
 * `agent.message` input from "heartbeat", Prime's `[heartbeat: <schedule> run#<n>]` text, steering a busy run or following it up as the job
 * asks. When the thread closes the handle goes, and each due tick asks pi-host to reopen the job; host.ts passes a durable job to
 * `reopenDurableHeartbeat`, which attaches a handle for that tick that submits through the thread list, so the thread file opens only when a
 * tick lands. That reopen is where Prime's daemon checks a restored session, so an archived or deleted thread cancels its heartbeats there.
 */
import { basename } from "node:path";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { hostApi } from "../api.ts";
import type { Job } from "../schedule.ts";
import type { ScheduledMessage, Scheduler, SendMode, SessionHandle } from "../scheduler.ts";
import { rlmHeartbeatHandler } from "../scheduler-extension.ts";
import type { HostCall, HostModule, HostModuleOptions } from "./host-modules.ts";
import type { RlmSubmit } from "./rlm.ts";

const TYPES = ["rlm_heartbeat.list", "rlm_heartbeat.create", "rlm_heartbeat.update", "rlm_heartbeat.delete"] as const;
const THREAD_FILE = ".sqlite";

type Input = Omit<RlmSubmit, "conversation">;

/** What a durable heartbeat reaches of pi-host's thread list after the thread closed; `DurableThreads` has it. */
export interface HeartbeatThreads {
  fileOf(id: string): string;
  info(id: string): { archived?: boolean };
  submit(id: string, input: Input & { conversation: number }): Promise<unknown>;
}

export interface HeartbeatModuleOptions extends HostModuleOptions {
  /** The scheduler the jobs live in; default pi-host's own (`hostApi().scheduler`). */
  scheduler?: () => Scheduler | undefined;
}

/** The thread and conversation a durable job targets, or undefined for a pi session's job. */
export function durableTarget(job: Pick<Job, "activeSessionId" | "sessionFile">, threads: Pick<HeartbeatThreads, "fileOf">): { thread: string; conversation: number } | undefined {
  if (!job.sessionFile.endsWith(THREAD_FILE)) return undefined;
  const thread = basename(job.sessionFile, THREAD_FILE);
  try {
    if (threads.fileOf(thread) !== job.sessionFile) return undefined;
  } catch {
    return undefined;
  }
  if (job.activeSessionId === thread) return { thread, conversation: ROOT_CONVERSATION_ID };
  const conversation = job.activeSessionId.startsWith(`${thread}-`) ? Number(job.activeSessionId.slice(thread.length + 1)) : NaN;
  return Number.isInteger(conversation) && conversation > ROOT_CONVERSATION_ID ? { thread, conversation } : undefined;
}

/** A scheduler handle for one durable conversation: a due heartbeat becomes an input that `deliver` admits. */
function durableHandle(scheduler: Scheduler, input: {
  session: string; thread: string; file: string; cwd: string; conversation: number; busy: () => boolean; deliver: (input: Input) => Promise<unknown>; log: (line: string) => void;
}): SessionHandle {
  const child = input.conversation !== ROOT_CONVERSATION_ID;
  return {
    sessionId: input.session, sessionFile: input.file, cwd: input.cwd, role: child ? "child" : "root", ...(child ? { rootSessionId: input.thread } : {}),
    activity: () => ({ streaming: input.busy(), compacting: false, retrying: false, pending: false }),
    send: (message: ScheduledMessage, mode: SendMode) => {
      const text = "text" in message ? message.text : message.content;
      const details = "details" in message ? message.details : {};
      const job = scheduler.list({ sessionId: input.session, includeInactive: true }).find(j => j.id === details.jobId);
      // A durable input starts a run when the conversation is idle and takes `whenBusy` only when it runs, so "start" keeps the job's mode.
      const followUp = mode === "followUp" || (mode === "start" && job?.deliveryMode === "follow_up");
      void input.deliver({
        text, requestId: `rlm_heartbeat:${String(details.jobId ?? "job")}:${String(details.runCount ?? Date.now())}`, whenBusy: followUp ? "followUp" : "steer",
        entry: { kind: "agent.message", data: { from: "heartbeat", via: job?.source ?? "rlm_heartbeat" } },
      }).catch(error => input.log(`heartbeat ${String(details.jobId ?? "").slice(0, 8)} did not reach ${input.session}: ${error instanceof Error ? error.message : String(error)}`));
    },
  };
}

/**
 * Attaches a handle for a due durable job whose thread is closed, as host.ts's `reopenFor` does for a pi session. Returns false for a job that
 * is not a durable thread's. An archived or missing thread cancels the session's jobs and throws, so the tick records why, as Prime's daemon
 * cancels a heartbeat whose session was archived or is gone (`restoreRlmHeartbeatSession`).
 */
export function reopenDurableHeartbeat(scheduler: Scheduler, job: Job, threads: HeartbeatThreads, log: (line: string) => void = () => {}): boolean {
  const target = durableTarget(job, threads);
  if (!target) return false;
  let archived: boolean;
  try {
    archived = threads.info(target.thread).archived === true;
  } catch {
    scheduler.cancelSession(job.activeSessionId);
    throw new Error(`durable thread ${target.thread} is gone; its heartbeats were cancelled`);
  }
  if (archived) {
    scheduler.cancelSession(job.activeSessionId);
    throw new Error(`durable thread ${target.thread} was archived; its heartbeats were cancelled`);
  }
  // The handle serves this one tick, so the next tick whose conversation has no module handle reads the thread's row again.
  const detach = scheduler.attach(durableHandle(scheduler, {
    session: job.activeSessionId, thread: target.thread, file: job.sessionFile, cwd: job.cwd, conversation: target.conversation, busy: () => false,
    deliver: input => { detach(); return threads.submit(target.thread, { ...input, conversation: target.conversation }); }, log,
  }));
  return true;
}

export function heartbeatModule(options: HeartbeatModuleOptions): HostModule {
  const schedulerOf = options.scheduler ?? (() => hostApi()?.scheduler);
  /** The handles this module attached, by session, with whether a run of the conversation is going. */
  const attached = new Map<string, { thread: string; busy: boolean; handle: SessionHandle; detach: () => void }>();

  const attach = (scheduler: Scheduler, call: HostCall) => {
    const held = attached.get(call.session);
    if (held && scheduler.handle(call.session) === held.handle) return held;
    held?.detach();
    const state = { thread: call.thread.id, busy: false } as { thread: string; busy: boolean; handle: SessionHandle; detach: () => void };
    state.handle = durableHandle(scheduler, {
      session: call.session, thread: call.thread.id, file: call.thread.file, cwd: call.thread.cwd, conversation: call.conversation,
      busy: () => state.busy, deliver: input => call.submit(input), log: call.log,
    });
    state.detach = scheduler.attach(state.handle);
    attached.set(call.session, state);
    return state;
  };

  return {
    name: "heartbeat",
    types: TYPES,
    request: (call, type, payload) => {
      const scheduler = schedulerOf();
      if (!scheduler) throw new Error("rlm_heartbeat needs pi-host's scheduler, which this process has not started.");
      const state = attach(scheduler, call);
      if (call.api) state.busy = true;
      return rlmHeartbeatHandler(scheduler, call.session, type, payload);
    },
    settled: async call => {
      const state = attached.get(call.session);
      if (state) state.busy = false;
    },
    closeThread: async threadId => {
      for (const [session, state] of attached) {
        if (state.thread !== threadId) continue;
        state.detach();
        attached.delete(session);
      }
    },
    shutdown: async () => {
      for (const state of attached.values()) state.detach();
      attached.clear();
    },
  };
}
