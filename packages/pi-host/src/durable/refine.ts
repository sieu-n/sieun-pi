/**
 * Prime's `refine` Python module in a durable thread: `refine.run` and `refine.status`, with Prime's answers (agent-session.ts
 * `handleRefineHostRequest`). `refine.run` only schedules: the request waits in the conversation's `prime.refine` document, so a pi-host restart
 * before the run settles keeps it. When the run settles (`settled`), the module plans with Prime's planner prompt on the conversation's own model,
 * applies the edits to the conversation's local store (`HostCall.harnessDir`, the agent's store in an agent's thread) or with `global=True` to the
 * global one, records the refine, and hands the conversation Prime's `[self-refinement]` notice as an input, so the agent resumes and the next
 * turn's digest update (`prime-harness.ts`) shows the change. This keeps owner rule c86, a refine in the same turn as its correction.
 *
 * The planning, the edit rules and the texts are pi-harness's port of Prime 0.9.8 (`packages/pi-harness/src/core`). A store write goes through its
 * `updateState`, which holds the file lock Prime's `harness.py` takes, and two refines of one store run one after the other.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { defineDoc, ROOT_CONVERSATION_ID, type ConversationId, type JsonObject } from "@earendil-works/pi-durable";
import { conversationText, fitPrompt } from "../../../pi-harness/src/core/conversation.ts";
import {
  applyProposal, mergeHistory, newRefineId, noticeContent, outcomeContent, parseProposal, plannerPrompt, PLANNER_PROMPT, type RefineResult,
} from "../../../pi-harness/src/core/refine.ts";
import { appendRefinementLog, mergeStates, readRefinementLog, readState, stateFile, updateState, type Scope } from "../../../pi-harness/src/core/store.ts";
import type { HostCall, HostModule, HostModuleOptions } from "./host-modules.ts";
import { getGlobalHarnessStateDir } from "./vendor/prime-harness.ts";

const context = BACKGROUND_CONTEXT;

/** Prime's answer to `refine.run` outside a run. */
export const NO_ACTIVE_TURN = "no active turn; refine can only be requested while a turn is running";
/** Prime's note for a scheduled refine. */
export const SCHEDULED_NOTE =
  "Refinement runs when the current turn ends; applied edits are appended to your context as a refinement notice and you resume automatically. Continue working normally.";
/** Prime's planner keeps the last 80,000 characters of the conversation (refinement.ts `planRefinement`). */
const PLANNER_CONVERSATION = 80_000;
/** Prime's `REFINEMENT_MAX_OUTPUT_TOKENS`, the planner's output cap when reasoning is off. */
const NO_THINKING_PLANNER_TOKENS = 32_000;

/** A `refine.run` the conversation's next settle serves; `id` tells a request that came while a refine planned from the one it serves. */
type Pending = { id: string; instructions?: string; global?: boolean; at: number };

/** Prime's `prime-agent.refinement` session entries: the pending request and each refine record of the conversation. */
export const RefineDoc = defineDoc<{ pending: Pending | null; records: JsonObject[] }>({
  kind: "prime.refine",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ pending: null, records: [] }),
  checkpointWhen: () => true,
});

/** The planner call, which a test replaces; default the conversation's model through `call.models`. */
export type PlannerCall = (call: HostCall, systemPrompt: string, conversation: string, build: (conversation: string) => string, signal: AbortSignal) => Promise<string>;

export interface RefineModuleOptions extends HostModuleOptions {
  /** The global store; default `<agentDir>/harness`, the one the digest reads (`prime-harness.ts` `mergedHarnessState`). */
  globalDir?: string;
  planner?: PlannerCall;
}

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The conversation's model reply to one planner prompt, with Prime's auxiliary reasoning level (`getAuxiliaryThinkingLevel`). */
const modelPlanner: PlannerCall = async (call, systemPrompt, conversation, build, signal) => {
  const agent = await (await call.harness.conversation(call.conversation as ConversationId, context))?.agent(context);
  if (!agent?.model) throw new Error("No model selected.");
  const model = call.models?.getModel(agent.model.provider, agent.model.modelId);
  if (!call.models || !model) throw new Error(`model ${agent.model.provider}/${agent.model.modelId} is not in the thread's catalog`);
  const thinking = agent.thinkingLevel ?? "low";
  const reasoning = clampThinkingLevel(model, thinking === "off" || thinking === "minimal" ? thinking : "low");
  const fit = fitPrompt(model, systemPrompt, conversation, build, reasoning === "off" ? NO_THINKING_PLANNER_TOKENS : model.maxTokens);
  const maxTokens = reasoning === "off" ? Math.min(fit.maxTokens, NO_THINKING_PLANNER_TOKENS) : fit.maxTokens;
  const reply: AssistantMessage = await call.models.completeSimple(
    model,
    { systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: fit.prompt }], timestamp: Date.now() }] },
    { ...(reasoning === "off" ? {} : { reasoning }), maxTokens, signal, sessionId: call.session },
  );
  if (reply.stopReason === "error") throw new Error(reply.errorMessage || "Unknown error");
  if (reply.stopReason === "aborted") throw new Error("aborted");
  if (reply.stopReason === "length") throw new Error("the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.");
  return reply.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
};

export function refineModule(options: RefineModuleOptions): HostModule {
  const globalDir = options.globalDir ?? getGlobalHarnessStateDir(options.agentDir);
  const planner = options.planner ?? modelPlanner;
  /** The refine running for each `<thread>:<conversation>`, with the request it serves. */
  const running = new Map<string, { serves: string; abort: AbortController }>();
  /** The last refine of each store, so two refines of one store never overlap. */
  const stores = new Map<string, Promise<unknown>>();
  const keyOf = (call: HostCall) => `${call.thread.id}:${call.conversation}`;

  const read = async (call: HostCall) => call.harness.snapshot(RefineDoc, call.conversation as ConversationId, context);
  const write = (call: HostCall, change: (doc: { pending: Pending | null; records: JsonObject[] }) => void) =>
    call.harness.commit(async tx => change(await tx.doc(RefineDoc, call.conversation as ConversationId) as never), context);

  /** Runs `work` after the last refine of the store in `dir`. */
  const exclusive = <T>(dir: string, work: () => Promise<T>): Promise<T> => {
    const key = resolve(stateFile(dir));
    const run = (stores.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    const kept = run.catch(() => undefined);
    stores.set(key, kept);
    void kept.then(() => { if (stores.get(key) === kept) stores.delete(key); });
    return run;
  };

  /** One refine: plan on the conversation's context, then apply under the store lock and record the event (agent-session.ts `_planRefine`, `_applyRefine`). */
  const refine = async (call: HostCall, ask: Pending, signal: AbortSignal): Promise<RefineResult> => {
    const scope: Scope = ask.global ? "global" : "local";
    const dir = scope === "global" ? globalDir : call.harnessDir;
    return exclusive(dir, async () => {
      const records = mergeHistory(readRefinementLog<RefineResult>(globalDir), ((await read(call))?.records ?? []) as unknown as RefineResult[]);
      const global = readState(globalDir, "global");
      const local = readState(call.harnessDir, "local");
      const text = conversationText(await contextMessages(call) as never).slice(-PLANNER_CONVERSATION);
      const reply = await planner(call, PLANNER_PROMPT, text,
        c => plannerPrompt(scope === "global" ? global : mergeStates(global, local), records, c, { global: scope === "global", ...(ask.instructions ? { instructions: ask.instructions } : {}) }), signal);
      const proposal = parseProposal(reply);
      if (signal.aborted) throw new Error("Refinement cancelled.");
      const id = newRefineId();
      const result = await updateState(dir, scope, state => applyProposal(state, proposal, { id, scope, baseline: scope === "global" ? global : local }));
      result.harnessStatePath = stateFile(dir);
      if (scope === "global") appendRefinementLog(globalDir, result);
      return result;
    });
  };

  /**
   * Serves the conversation's pending request once no run of it is going, in the background so the settle never waits on the planner. It
   * records the refine and hands over the notice; a request that came during the refine is served after it.
   */
  const serve = async (call: HostCall): Promise<void> => {
    const key = keyOf(call);
    if (running.has(key)) return;
    const doc = await read(call);
    const ask = doc?.pending;
    if (!ask || (await call.running())) return;
    if (lastAborted(await contextMessages(call))) {
      // Prime drops a pending refine.run when its turn was aborted (agent-session.ts `_checkCompaction`).
      await write(call, d => { if (d.pending?.id === ask.id) d.pending = null; });
      call.log(`refine ${ask.id} dropped: its turn was aborted`);
      return;
    }
    const abort = new AbortController();
    running.set(key, { serves: ask.id, abort });
    void (async () => {
      try {
        const result = await refine(call, ask, abort.signal);
        await write(call, d => {
          if (d.pending?.id === ask.id) d.pending = null;
          d.records.push(json(result) as unknown as JsonObject);
        });
        const applied = result.appliedEdits.filter(e => e.applied).length;
        call.log(`${outcomeContent(result)} (${result.id}, ${applied} of ${result.appliedEdits.length} edits applied, ${result.scope})`);
        // Prime posts no notice for a refine with no applied edit, and the agent does not resume.
        if (applied > 0) {
          call.submit({
            text: noticeContent(result, "self"), requestId: `refine-notice:${call.session}:${result.id}`, whenBusy: "followUp",
            entry: { kind: "agent.message", data: { from: "refine", via: "refine-notice" } },
          }).catch(error => call.log(`refine notice ${result.id} failed: ${message(error)}`));
        }
      } catch (error) {
        call.log(`Refinement failed: ${message(error)}`);
        // Prime does not retry a failed refine.run (`_emitRefineFailed`); a pi-host stop mid-plan keeps the request for the next settle.
        if (!abort.signal.aborted) await write(call, d => { if (d.pending?.id === ask.id) d.pending = null; }).catch(() => undefined);
      } finally {
        if (running.get(key)?.abort === abort) running.delete(key);
      }
      if (!abort.signal.aborted) await serve(call).catch(error => call.log(`refine: ${message(error)}`));
    })();
  };

  return {
    name: "refine",
    types: ["refine.run", "refine.status"],
    async request(call, type, payload) {
      // Prime registers refine.* only for a depth 0 session with a local store (`_autoRefineAllowedForSession`).
      if (call.conversation !== ROOT_CONVERSATION_ID) throw new Error(`${type} runs only in a thread's root conversation, as Prime registers refine.* only at depth 0`);
      if (type === "refine.status") {
        const pending = (await read(call))?.pending;
        const now = running.get(keyOf(call));
        return { pending: Boolean(pending && pending.id !== now?.serves), in_flight: now !== undefined };
      }
      const instructions = payload.instructions;
      if (instructions !== undefined && typeof instructions !== "string") throw new Error("refine.run instructions must be a string when provided");
      const global = payload.global;
      if (global !== undefined && typeof global !== "boolean") throw new Error("refine.run global must be a boolean when provided");
      if (!(await call.running())) return { scheduled: false, reason: NO_ACTIVE_TURN };
      const serving = running.get(keyOf(call))?.serves;
      await write(call, doc => {
        const previous = doc.pending && doc.pending.id !== serving ? doc.pending : undefined;
        const merged = { instructions: instructions ?? previous?.instructions, global: global ?? previous?.global };
        doc.pending = { id: randomBytes(4).toString("hex"), at: Date.now(), ...(merged.instructions !== undefined ? { instructions: merged.instructions } : {}), ...(merged.global !== undefined ? { global: merged.global } : {}) };
      });
      return { scheduled: true, note: SCHEDULED_NOTE };
    },
    async settled(call) {
      if (call.conversation !== ROOT_CONVERSATION_ID) return;
      await serve(call);
    },
    async closeThread(threadId) {
      for (const [key, now] of running) if (key.startsWith(`${threadId}:`)) now.abort.abort();
    },
    async shutdown() {
      for (const now of running.values()) now.abort.abort();
    },
  };
}

async function contextMessages(call: HostCall): Promise<Message[]> {
  const conv = await call.harness.conversation(call.conversation as ConversationId, context);
  return conv ? (await conv.context(context)).messages.filter(m => m.role !== "system") as Message[] : [];
}

/** Whether the run's last answer was aborted. */
function lastAborted(messages: readonly Message[]): boolean {
  const last = messages.findLast(m => m.role === "assistant") as AssistantMessage | undefined;
  return last?.stopReason === "aborted";
}
