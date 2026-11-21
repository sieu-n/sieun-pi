/**
 * Prime's `refine` Python module in a durable thread: `refine.run` and `refine.status`, with Prime's answers (agent-session.ts
 * `handleRefineHostRequest`). `refine.run` only schedules: the request waits in the conversation's `prime.refine` document, so a pi-host restart
 * before the run settles keeps it. When the run settles (`settled`), the module plans with Prime's planner prompt on the conversation's own model,
 * applies the edits to the conversation's local store (`HostCall.harnessDir`, the agent's store in an agent's thread) or with `global=True` to the
 * global one, records the refine, and hands the conversation Prime's `[self-refinement]` notice as an input, so the agent resumes and the next
 * turn's digest update (`prime-harness.ts`) shows the change. This keeps owner rule c86, a refine in the same turn as its correction.
 *
 * Prime's auto-refine runs here too: at a settle with no request, after Prime's turn interval or a compaction and its cooldown, Prime's review
 * gate asks the model whether the turns hold something to keep, and a yes runs the planner with Prime's auto instructions. In an agent's
 * thread the root and every job conversation refine and auto-refine into the agent's store, with the planner and review told it is the
 * agent's memory (pi-harness `agentPolicy`), so an agent keeps its own memory with no one asking.
 *
 * A general standard, such as a coding standard or how every agent writes, goes to a skill rather than a store (owner, #sw-factory-build p110):
 * the planner returns it as a skill route (pi-harness `ROUTE_POLICY`), and the thread's root gets a `[skill-route]` input that has it make the
 * edit through a commit, as sieun-pi's `skills/refine-harness` says. A walk's throwaway test agent (`HostCall.test`) gets no route and no global
 * write: every refine of it writes its own store, which goes with it, since a lesson from a made-up task must not change shared rules. On 11-21
 * a blind run's test agent got a route and pushed d87524e0, a config/AGENTS.md change for every agent.
 *
 * The planning, the edit rules and the texts are pi-harness's port of Prime 0.9.8 (`packages/pi-harness/src/core`). A store write goes through its
 * `updateState`, which holds the file lock Prime's `harness.py` takes, and two refines of one store run one after the other.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { defineDoc, ROOT_CONVERSATION_ID, type ConversationId, type JsonObject } from "@earendil-works/pi-durable";
import { conversationText, fitPrompt } from "../../../pi-harness/src/core/conversation.ts";
import {
  applyProposal, autoRefineInstructions, mergeHistory, newRefineId, noticeContent, outcomeContent, parseProposal, parseReview, plannerPrompt, PLANNER_PROMPT,
  REVIEW_PROMPT, reviewPrompt, skillRouteContent, type AutoReason, type RefineResult,
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
/** Prime's review gate reads the last 40,000 characters and answers in at most 4,096 tokens with reasoning off (pi-harness `index.ts`). */
const REVIEW_CONVERSATION = 40_000;
const NO_THINKING_REVIEW_TOKENS = 4_096;
/** The note a job of an agent gets: its refine writes the agent's memory and, as a child, it is not resumed with a notice. */
export const JOB_SCHEDULED_NOTE =
  "Refinement runs when the current turn ends and writes your agent's memory, which every later thread of the agent reads. You get no notice; continue working normally.";

/** Prime's `autoRefine` settings keys in `<agentDir>/settings.json`, with Prime's defaults: on, every 25 assistant turns and at a compaction, 20 minutes apart. */
export type AutoRefine = { enabled: boolean; turnInterval: number; compact: boolean; cooldownMs: number };
export function autoRefineSettings(agentDir: string): AutoRefine {
  let raw: Record<string, unknown> = {};
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
    if (settings.autoRefine && typeof settings.autoRefine === "object") raw = settings.autoRefine as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  return { enabled: raw.enabled !== false, turnInterval: Math.max(1, num(raw.turnInterval, 25)), compact: raw.compact !== false, cooldownMs: Math.max(0, num(raw.cooldownMs, 1_200_000)) };
}

/** A `refine.run` the conversation's next settle serves; `id` tells a request that came while a refine planned from the one it serves. */
type Pending = { id: string; instructions?: string; global?: boolean; at: number; auto?: AutoReason };
/** The last auto-refine review: when it ran and the newest context entry it read, so the next one counts the turns after it. */
type Reviewed = { at: number; after: number };

/** Prime's `prime-agent.refinement` session entries: the pending request and each refine record of the conversation, and the last auto review. */
export const RefineDoc = defineDoc<{ pending: Pending | null; records: JsonObject[]; reviewed?: Reviewed }>({
  kind: "prime.refine",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ pending: null, records: [] }),
  checkpointWhen: () => true,
});

/** The planner call, which a test replaces; default the conversation's model through `call.models`. */
export type PlannerCall = (call: HostCall, systemPrompt: string, conversation: string, build: (conversation: string) => string, signal: AbortSignal, noThinkingCap?: number) => Promise<string>;

export interface RefineModuleOptions extends HostModuleOptions {
  /** The global store; default `<agentDir>/harness`, the one the digest reads (`prime-harness.ts` `mergedHarnessState`). */
  globalDir?: string;
  planner?: PlannerCall;
  /** Prime's auto-refine settings; default `autoRefineSettings(agentDir)`, read at each settle. */
  autoRefine?: () => AutoRefine;
}

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The conversation's model reply to one planner prompt, with Prime's auxiliary reasoning level (`getAuxiliaryThinkingLevel`). */
const modelPlanner: PlannerCall = async (call, systemPrompt, conversation, build, signal, noThinkingCap = NO_THINKING_PLANNER_TOKENS) => {
  const agent = await (await call.harness.conversation(call.conversation as ConversationId, context))?.agent(context);
  if (!agent?.model) throw new Error("No model selected.");
  const model = call.models?.getModel(agent.model.provider, agent.model.modelId);
  if (!call.models || !model) throw new Error(`model ${agent.model.provider}/${agent.model.modelId} is not in the thread's catalog`);
  const thinking = agent.thinkingLevel ?? "low";
  const reasoning = clampThinkingLevel(model, thinking === "off" || thinking === "minimal" ? thinking : "low");
  const fit = fitPrompt(model, systemPrompt, conversation, build, reasoning === "off" ? noThinkingCap : model.maxTokens);
  const maxTokens = reasoning === "off" ? Math.min(fit.maxTokens, noThinkingCap) : fit.maxTokens;
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
  const autoSettings = options.autoRefine ?? (() => autoRefineSettings(options.agentDir));
  /** The refine running for each `<thread>:<conversation>`, with the request it serves. */
  const running = new Map<string, { serves: string; abort: AbortController }>();
  /** The last refine of each store, so two refines of one store never overlap. */
  const stores = new Map<string, Promise<unknown>>();
  const keyOf = (call: HostCall) => `${call.thread.id}:${call.conversation}`;

  const read = async (call: HostCall) => call.harness.snapshot(RefineDoc, call.conversation as ConversationId, context);
  const write = (call: HostCall, change: (doc: { pending: Pending | null; records: JsonObject[]; reviewed?: Reviewed }) => void) =>
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
    const scope: Scope = ask.global && !call.test ? "global" : "local";
    const dir = scope === "global" ? globalDir : call.harnessDir;
    return exclusive(dir, async () => {
      const records = mergeHistory(readRefinementLog<RefineResult>(globalDir), ((await read(call))?.records ?? []) as unknown as RefineResult[]);
      const global = readState(globalDir, "global");
      const local = readState(call.harnessDir, "local");
      const text = conversationText(await contextMessages(call) as never).slice(-PLANNER_CONVERSATION);
      const args = { global: scope === "global", routes: !call.test, ...(ask.instructions ? { instructions: ask.instructions } : {}), ...(scope === "local" && call.agent ? { agent: call.agent } : {}) };
      const reply = await planner(call, PLANNER_PROMPT, text, c => plannerPrompt(scope === "global" ? global : mergeStates(global, local), records, c, args), signal);
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
   * Whether Prime's auto-refine review is due at this settle (pi-harness `afterRun`): Prime's turn interval of assistant messages since the last
   * review, or a compaction after it, and the cooldown since it. It runs for a thread's root conversation, as Prime's does for a depth 0
   * session, and for each job conversation of an agent's thread, whose store is the agent's memory that outlives the job.
   */
  const autoDue = async (call: HostCall, reviewed: Reviewed | undefined): Promise<{ reason: AutoReason; turns: number; tail: number } | undefined> => {
    if (call.conversation !== ROOT_CONVERSATION_ID && !call.agent) return undefined;
    const auto = autoSettings();
    if (!auto.enabled) return undefined;
    if (reviewed && Date.now() - reviewed.at < auto.cooldownMs) return undefined;
    const view = await (await call.harness.conversation(call.conversation as ConversationId, context))?.context(context);
    if (!view) return undefined;
    const after = reviewed?.after ?? 0;
    let turns = 0;
    view.entries.forEach((entry, index) => {
      if ((entry.id as number) > after) turns += (view.contributions[index] ?? []).filter(m => m.role === "assistant").length;
    });
    const head = view.head;
    const compacted = auto.compact && head?.kind === "pi.compaction" && (head.id as number) > after;
    const reason: AutoReason = compacted ? "compact" : "turn_interval";
    if (reason === "turn_interval" && turns < auto.turnInterval) return undefined;
    return { reason, turns, tail: Math.max(0, ...view.entries.map(entry => entry.id as number)) };
  };

  /** Prime's review gate: asks the conversation's model whether the turns since the last review hold something to keep; records the review first. */
  const review = async (call: HostCall, due: { reason: AutoReason; turns: number; tail: number }, signal: AbortSignal) => {
    await write(call, d => { d.reviewed = { at: Date.now(), after: due.tail }; });
    const records = mergeHistory(readRefinementLog<RefineResult>(globalDir), ((await read(call))?.records ?? []) as unknown as RefineResult[]);
    const state = mergeStates(readState(globalDir, "global"), readState(call.harnessDir, "local"));
    const text = conversationText(await contextMessages(call) as never).slice(-REVIEW_CONVERSATION);
    const trigger = { reason: due.reason, turnsSinceLastReview: due.turns, ...(call.agent ? { agent: call.agent } : {}) };
    return parseReview(await planner(call, REVIEW_PROMPT, text, c => reviewPrompt(state, records, c, trigger), signal, NO_THINKING_REVIEW_TOKENS));
  };

  /**
   * Serves the conversation's pending request, or Prime's auto-refine when one is due, once no run of it is going, in the background so the
   * settle never waits on the model. It records the refine and hands a root conversation the notice of a refine it asked for; a request that
   * came during the refine is served after it.
   */
  const serve = async (call: HostCall): Promise<void> => {
    const key = keyOf(call);
    if (running.has(key)) return;
    const doc = await read(call);
    if (await call.running()) return;
    const ask = doc?.pending ?? undefined;
    if (ask && lastAborted(await contextMessages(call))) {
      // Prime drops a pending refine.run when its turn was aborted (agent-session.ts `_checkCompaction`).
      await write(call, d => { if (d.pending?.id === ask.id) d.pending = null; });
      call.log(`refine ${ask.id} dropped: its turn was aborted`);
      return;
    }
    const due = ask ? undefined : await autoDue(call, doc?.reviewed);
    if (!ask && !due) return;
    const abort = new AbortController();
    running.set(key, { serves: ask?.id ?? "auto", abort });
    void (async () => {
      try {
        let job = ask;
        if (!job && due) {
          const decision = await review(call, due, abort.signal);
          call.log(`auto-refine review (${due.reason}, ${due.turns} turns): ${decision.shouldRefine ? "refine" : "no refine"}; ${decision.rationale}`);
          if (decision.shouldRefine) job = { id: "auto", at: Date.now(), auto: due.reason, instructions: autoRefineInstructions(due.reason, decision, call.agent) };
        }
        if (!job) return;
        const served = job;
        const result = await refine(call, served, abort.signal);
        await write(call, d => {
          if (d.pending?.id === served.id) d.pending = null;
          d.records.push(json(result) as unknown as JsonObject);
        });
        const applied = result.appliedEdits.filter(e => e.applied).length;
        const routed = result.skillRoutes?.length ? `, ${result.skillRoutes.length} skill routes` : "";
        call.log(`${outcomeContent(result)} (${result.id}, ${applied} of ${result.appliedEdits.length} edits applied, ${result.scope}${routed}${served.auto ? `, auto ${served.auto}` : ""})`);
        // A general standard goes to a skill through a commit (skills/refine-harness, #sw-factory-build p110), so its routes start a turn of
        // the thread's root, also for an auto-refine or a job's refine, since the root is the conversation that edits and commits or hands it on.
        if (result.skillRoutes?.length && call.test) call.log(`skill routes of ${result.id} dropped: a test agent changes no shared rule`);
        else if (result.skillRoutes?.length) {
          const job = call.conversation === ROOT_CONVERSATION_ID ? undefined : call.conversation;
          call.submitRoot({
            text: skillRouteContent(result, job), requestId: `skill-route:${call.session}:${result.id}`, whenBusy: "followUp",
            entry: { kind: "agent.message", data: { from: "refine", via: "skill-route" } },
          }).catch(error => call.log(`skill route ${result.id} failed: ${message(error)}`));
        }
        // Prime posts no notice for a refine with no applied edit, and an auto-refine's notice starts no turn; a job is not resumed either.
        if (applied > 0 && !served.auto && call.conversation === ROOT_CONVERSATION_ID) {
          call.submit({
            text: noticeContent(result, "self"), requestId: `refine-notice:${call.session}:${result.id}`, whenBusy: "followUp",
            entry: { kind: "agent.message", data: { from: "refine", via: "refine-notice" } },
          }).catch(error => call.log(`refine notice ${result.id} failed: ${message(error)}`));
        }
      } catch (error) {
        call.log(`Refinement failed: ${message(error)}`);
        // Prime does not retry a failed refine.run (`_emitRefineFailed`); a pi-host stop mid-plan keeps the request for the next settle.
        if (ask && !abort.signal.aborted) await write(call, d => { if (d.pending?.id === ask.id) d.pending = null; }).catch(() => undefined);
      } finally {
        if (running.get(key)?.abort === abort) running.delete(key);
      }
      if (!abort.signal.aborted) await serve(call).catch(error => call.log(`refine: ${message(error)}`));
    })();
  };

  /** Prime registers refine.* only for a depth 0 session; a job of an agent's thread gets it too, since its store is the agent's memory. */
  const refines = (call: HostCall): boolean => call.conversation === ROOT_CONVERSATION_ID || call.agent !== undefined;

  return {
    name: "refine",
    types: ["refine.run", "refine.status"],
    async request(call, type, payload) {
      if (!refines(call)) throw new Error(`${type} runs only in a thread's root conversation, as Prime registers refine.* only at depth 0`);
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
      return { scheduled: true, note: call.conversation === ROOT_CONVERSATION_ID ? SCHEDULED_NOTE : JOB_SCHEDULED_NOTE };
    },
    async settled(call) {
      if (!refines(call)) return;
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
