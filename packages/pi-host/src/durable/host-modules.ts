/**
 * The kernel host requests of Prime's `goal`, `refine`, `rlm_heartbeat` and `mcp` Python modules in a durable thread. Each module is one
 * `HostModule` in its own file; `rlm.ts` routes a request whose type a module lists to that module, and tells every module when a run of a
 * conversation settled and when a thread closed.
 */
import type { Harness, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import type { RlmSubmit, RlmThread } from "./rlm.ts";

/** One conversation of a thread as a module reaches it. */
export interface HostCall {
  readonly thread: RlmThread;
  readonly conversation: number;
  /** The conversation's session id by Prime's rule (`harnessSessionOf`): the thread id for the root, `<thread>-<conversation>` for a child. */
  readonly session: string;
  /** The conversation's local harness store, the agent's in a thread that belongs to one (`conversationHarnessDir`). */
  readonly harnessDir: string;
  readonly harness: Harness;
  /** The ipython call running now; absent for a request outside a cell and at a settle. */
  readonly api?: ToolExecutionApi;
  readonly models?: Models;
  /** Whether a run of the conversation is going now. */
  running(): Promise<boolean>;
  /** Whether the conversation still has work out: an rlm child that runs or a live `bash()` handle in its kernel. */
  workOut(): Promise<boolean>;
  /** Admits an input to this conversation. */
  submit(input: Omit<RlmSubmit, "conversation">): Promise<unknown>;
  log(line: string): void;
}

export interface HostModule {
  readonly name: string;
  /** The host request types it answers, such as `goal.get`. */
  readonly types: readonly string[];
  request(call: HostCall, type: string, payload: Record<string, unknown>): unknown;
  /** A run of the conversation settled. A module must not await a submit to the same conversation here (see `DurableRlm.settled`). */
  settled?(call: HostCall): Promise<void>;
  /** The thread's file closed; drop what the module holds for it. */
  closeThread?(threadId: string): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface HostModuleOptions {
  agentDir: string;
  log: (line: string) => void;
}
