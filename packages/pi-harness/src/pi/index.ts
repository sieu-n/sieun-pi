import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { identityOf } from "@sieun-pi/pi-family/registry";
import { registerKernelHandler } from "@sieun-pi/pi-family/kernel-bridge";
import { sessionArtifactDir } from "@sieun-pi/pi-family/paths";
import {
  appendRefinementLog,
  filesIdentity,
  globalHarnessDir,
  localHarnessDir,
  mergeStates,
  readRefinementLog,
  readState,
  stateFile,
  updateState,
  type HarnessState,
  type Scope,
} from "../core/store.ts";
import { buildDelta, buildDigest, buildQueryTerms, digestMessageContent, fingerprint, updateMessageContent, type DigestOptions } from "../core/digest.ts";
import {
  applyProposal,
  autoRefineInstructions,
  mergeHistory,
  newRefineId,
  noticeContent,
  noticeDetails,
  NOTICE_TYPE,
  outcomeContent,
  outcomeDetails,
  OUTCOME_TYPE,
  parseProposal,
  parseRefineArgs,
  parseReview,
  plannerPrompt,
  PLANNER_PROMPT,
  recordScope,
  REFINEMENT_ENTRY,
  reviewPrompt,
  REVIEW_PROMPT,
  rollbackProposal,
  type AutoReason,
  type RefineArgs,
  type RefineProposal,
  type RefineResult,
  type RefineSource,
} from "../core/refine.ts";
import { conversationText, fitPrompt } from "../core/conversation.ts";

/**
 * pi-harness: Prime's continual harness as a Pi extension.
 *
 * It injects the harness digest at each run start, keeps `harness_state.json` in Prime's format, runs `/refine`, `/refine rollback`,
 * the kernel's `refine.run()` and auto-refine every 25 assistant turns or after a compaction, and posts Prime's notice messages.
 */

export const DIGEST_TYPE = "harness_digest";
export const SECTION_ENTRY = "harness_section";
const SECTION = "harness_state";
const PLANNER_CONVERSATION = 80_000;
const REVIEW_CONVERSATION = 40_000;
const NO_THINKING_PLANNER_TOKENS = 32_000;
const NO_THINKING_REVIEW_TOKENS = 4_096;
const SKIP_IN_TRAJECTORY = new Set([OUTCOME_TYPE]);
/** Prime kept digest messages and refine outcomes out of the compaction summarizer's input, and so does this extension. */
const SKIP_IN_SUMMARY = new Set([DIGEST_TYPE, OUTCOME_TYPE]);

export type DigestRoute = "message" | "section";

interface AutoRefineSettings {
  enabled: boolean;
  turnInterval: number;
  compact: boolean;
  cooldownMs: number;
}

interface HarnessSettings {
  autoRefine: AutoRefineSettings;
  auxiliaryModel?: string;
  digestRoute: DigestRoute;
}

/**
 * Prime's `getAutoRefineSettings` defaults, read from the same settings keys, plus `harness.digestRoute`.
 * The digest goes in as a custom message unless the route says "section": the 30-turn Anthropic cache probe in step 4 measured that a
 * changed section costs a cache write of the whole digest, or of the whole prefix on a model without mid-conversation system messages.
 */
export function readSettings(raw: Record<string, unknown>): HarnessSettings {
  const auto = (raw.autoRefine ?? {}) as Record<string, unknown>;
  const interval = typeof auto.turnInterval === "number" && Number.isFinite(auto.turnInterval) ? auto.turnInterval : 25;
  const cooldown = typeof auto.cooldownMs === "number" && Number.isFinite(auto.cooldownMs) ? auto.cooldownMs : 1_200_000;
  const harness = (raw.harness ?? {}) as Record<string, unknown>;
  const envRoute = process.env.PI_HARNESS_DIGEST_ROUTE;
  const route = envRoute === "message" || envRoute === "section" ? envRoute : harness.digestRoute === "section" ? "section" : "message";
  return {
    autoRefine: {
      enabled: auto.enabled !== false,
      turnInterval: Math.max(1, interval),
      compact: auto.compact !== false,
      cooldownMs: Math.max(0, cooldown),
    },
    auxiliaryModel: typeof raw.auxiliaryModel === "string" && raw.auxiliaryModel.trim() ? raw.auxiliaryModel.trim() : undefined,
    digestRoute: route,
  };
}

interface SessionHarness {
  id: string;
  depth: number;
  localDir?: string;
  globalDir: string;
  ctx: ExtensionContext;
  turns: number;
  lastReviewAt: number;
  compactPending: boolean;
  requested?: { instructions?: string; global?: boolean };
  inFlight?: Promise<void>;
  abort?: AbortController;
  cache?: { identity: string; global: HarnessState; local?: HarnessState };
  section?: { fingerprint: string; text: string };
  dispose: (() => void)[];
}

export interface HarnessExtensionOptions {
  /** The global store dir. Defaults to harness.py's rule: RLM_GLOBAL_HARNESS_STATE_DIR, else `<agent dir>/harness`. */
  globalDir?: string;
  /** Replaces the review and planner model calls, for tests. */
  complete?: (model: Model<Api>, systemPrompt: string, prompt: string, maxTokens: number, signal?: AbortSignal) => Promise<string>;
}

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join(" ");
}

export function createHarnessExtension(options: HarnessExtensionOptions = {}) {
  return function harness(pi: ExtensionAPI): void {
    const sessions = new Map<string, SessionHarness>();
    const settings = () => readSettings(pi.getSettings() as unknown as Record<string, unknown>);

    const loadStates = (s: SessionHarness) => {
      const identity = filesIdentity(s.localDir ? [s.globalDir, s.localDir] : [s.globalDir]);
      if (s.cache?.identity !== identity) s.cache = { identity, global: readState(s.globalDir, "global"), local: s.localDir ? readState(s.localDir, "local") : undefined };
      return s.cache;
    };

    const contextMessages = (ctx: ExtensionContext): AgentMessage[] =>
      buildSessionContext(ctx.sessionManager.getEntries() as never, ctx.sessionManager.getLeafId()).messages as AgentMessage[];

    const digestOptions = (s: SessionHarness, recent: string[]): DigestOptions => {
      const tools = pi.getActiveTools();
      const ipython = tools.includes("ipython");
      return {
        includeIpythonExamples: ipython,
        includeShellExamples: tools.includes("bash"),
        includeRefineExamples: ipython && s.depth === 0 && s.localDir !== undefined,
        queryTerms: buildQueryTerms(undefined, recent),
      };
    };

    /** The digest message for the next run in the message route, or undefined when the context already has the current state. */
    const nextDigestMessage = (s: SessionHarness, prompt: string | undefined) => {
      const { global, local } = loadStates(s);
      const state = mergeStates(global, local);
      const messages = contextMessages(s.ctx);
      const recent = messages.filter(m => m.role === "user" || m.role === "assistant").map(textOf);
      if (prompt) recent.push(prompt);
      const opts = digestOptions(s, recent);
      const { queryTerms, ...flags } = opts;
      const print = fingerprint(state, flags);
      const delivered: { at: number; text: string; details?: { digest?: string; stateFingerprint?: string } }[] = [];
      for (const m of messages) {
        if (m.role !== "custom" || (m as { customType: string }).customType !== DIGEST_TYPE) continue;
        delivered.push({ at: (m as { timestamp: number }).timestamp, text: textOf(m), details: (m as { details?: { digest?: string; stateFingerprint?: string } }).details });
      }
      const digest = buildDigest(state, opts);
      const latest = delivered.filter(d => d.details?.digest !== undefined).at(-1);
      if (!latest) return { customType: DIGEST_TYPE, content: digestMessageContent(digest), display: false, details: { digest, stateFingerprint: print } };
      if (latest.details?.stateFingerprint === print) return undefined;
      const delta = buildDelta(state, delivered.map(d => d.text), latest.at, opts);
      return {
        customType: DIGEST_TYPE,
        content: delta === undefined ? digestMessageContent(digest) : updateMessageContent(delta),
        display: false,
        details: { digest, stateFingerprint: print, stacked: true },
      };
    };

    /** The section text for the section route. It changes only when the stores change, so the cached prefix stays put between changes. */
    const sectionText = (s: SessionHarness, prompt: string | undefined): string => {
      const { global, local } = loadStates(s);
      const state = mergeStates(global, local);
      const recent = contextMessages(s.ctx).filter(m => m.role === "user" || m.role === "assistant").map(textOf);
      if (prompt) recent.push(prompt);
      const opts = digestOptions(s, recent);
      const { queryTerms, ...flags } = opts;
      const print = fingerprint(state, flags);
      if (!s.section) {
        const saved = s.ctx.sessionManager.getBranch().filter(e => e.type === "custom" && (e as { customType: string }).customType === SECTION_ENTRY).at(-1);
        const data = saved && (saved as { data?: { fingerprint?: string; text?: string } }).data;
        if (data?.fingerprint && typeof data.text === "string") s.section = { fingerprint: data.fingerprint, text: data.text };
      }
      if (s.section?.fingerprint === print) return s.section.text;
      s.section = { fingerprint: print, text: buildDigest(state, opts) };
      pi.appendEntry(SECTION_ENTRY, s.section);
      return s.section.text;
    };

    const refineModel = (s: SessionHarness): Model<Api> => {
      const wanted = settings().auxiliaryModel?.toLowerCase();
      const current = s.ctx.model;
      if (!current) throw new Error("No model selected.");
      if (!wanted || `${current.provider}/${current.id}`.toLowerCase() === wanted) return current;
      const found = s.ctx.modelRegistry.getAll().find(m => `${m.provider}/${m.id}`.toLowerCase() === wanted);
      if (!found) throw new Error(`auxiliaryModel "${wanted}" is unavailable`);
      return found;
    };

    const reasoningFor = (s: SessionHarness) => {
      const level = s.ctx.thinkingLevel;
      return level === "off" || level === "minimal" ? level : "low";
    };

    const callModel = async (s: SessionHarness, systemPrompt: string, conversation: string, build: (c: string) => string, noThinkingCap: number, signal?: AbortSignal) => {
      const model = refineModel(s);
      const reasoning = reasoningFor(s);
      const fit = fitPrompt(model, systemPrompt, conversation, build, reasoning === "off" ? noThinkingCap : model.maxTokens);
      const maxTokens = reasoning === "off" ? Math.min(fit.maxTokens, noThinkingCap) : fit.maxTokens;
      if (options.complete) return options.complete(model, systemPrompt, fit.prompt, maxTokens, signal);
      let attempt = 0;
      while (true) {
        const reply = await s.ctx.modelRegistry
          .streamSimple(model, { systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: fit.prompt }], timestamp: Date.now() }] }, { reasoning, maxTokens, signal, sessionId: s.id } as never)
          .result();
        if (reply.stopReason === "error" && attempt < 3 && !signal?.aborted) {
          attempt++;
          await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
          continue;
        }
        if (reply.stopReason === "error") throw new Error(reply.errorMessage || "Unknown error");
        if (reply.stopReason === "aborted") throw new Error("aborted");
        if (reply.stopReason === "length") throw new Error("the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.");
        return reply.content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("\n");
      }
    };

    const history = (s: SessionHarness): RefineResult[] => {
      const session = s.ctx.sessionManager
        .getEntries()
        .filter(e => e.type === "custom" && (e as { customType: string }).customType === REFINEMENT_ENTRY)
        .map(e => (e as { data: RefineResult }).data)
        .filter(d => d && typeof d.id === "string" && Array.isArray(d.appliedEdits));
      return mergeHistory(readRefinementLog<RefineResult>(s.globalDir), session);
    };

    /** One refine: plan (or a rollback proposal), apply under the store lock, record it, and post the outcome and notice. */
    const refine = async (s: SessionHarness, args: RefineArgs, signal?: AbortSignal): Promise<RefineResult> => {
      const requested: Scope = args.global ? "global" : "local";
      if (!args.rollbackId && requested === "local" && !s.localDir) throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
      const records = history(s);
      let scope: Scope = requested;
      let proposal: RefineProposal;
      let rollbackOf: string | undefined;
      let targetDir: string | undefined;
      let baseline: HarnessState | undefined;
      if (args.rollbackId) {
        const record = records.find(r => r.id === args.rollbackId);
        if (!record) throw new Error(`Refinement ${args.rollbackId} not found`);
        scope = recordScope(record) ?? requested;
        targetDir = record.harnessStatePath ? dirname(record.harnessStatePath) : scope === "global" ? s.globalDir : s.localDir;
        if (targetDir && stateFile(targetDir) === stateFile(s.globalDir)) scope = "global";
        proposal = rollbackProposal(record);
        rollbackOf = record.id;
      } else {
        const global = readState(s.globalDir, "global");
        const local = s.localDir ? readState(s.localDir, "local") : undefined;
        const planning = scope === "global" ? global : mergeStates(global, local);
        baseline = scope === "global" ? global : local;
        targetDir = scope === "global" ? s.globalDir : s.localDir;
        const conversation = conversationText(contextMessages(s.ctx), SKIP_IN_TRAJECTORY).slice(-PLANNER_CONVERSATION);
        const reply = await callModel(s, PLANNER_PROMPT, conversation, c => plannerPrompt(planning, records, c, { global: scope === "global", instructions: args.instructions }), NO_THINKING_PLANNER_TOKENS, signal);
        proposal = parseProposal(reply);
      }
      if (!targetDir) throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
      if (signal?.aborted) throw new Error("Refinement cancelled.");
      const id = newRefineId();
      const dir = targetDir;
      const result = await updateState(dir, scope, state => applyProposal(state, proposal, { id, scope, rollbackOf, baseline }));
      result.harnessStatePath = stateFile(dir);
      if (scope === "global") appendRefinementLog(s.globalDir, result);
      s.cache = undefined;
      pi.appendEntry(REFINEMENT_ENTRY, result);
      pi.sendMessage({ customType: OUTCOME_TYPE, content: outcomeContent(result), display: true, details: outcomeDetails(result) });
      return result;
    };

    /** Runs `work` as this session's one refine slot, so a run start waits for it and two refines never overlap. */
    const exclusive = (s: SessionHarness, work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
      const previous = s.inFlight ?? Promise.resolve();
      const abort = new AbortController();
      const run = previous.then(() => {
        s.abort = abort;
        return work(abort.signal);
      });
      const slot = run.catch(() => undefined).finally(() => {
        if (s.inFlight === slot) s.inFlight = undefined;
        if (s.abort === abort) s.abort = undefined;
      });
      s.inFlight = slot;
      return run;
    };

    /** Posts the hidden notice. A self refine resumes the agent, which runs `before_agent_start` and so sees the new digest. */
    const notify = (s: SessionHarness, result: RefineResult, source: RefineSource) => {
      if (!result.appliedEdits.some(e => e.applied)) return;
      pi.sendMessage(
        { customType: NOTICE_TYPE, content: noticeContent(result, source), display: false, details: noticeDetails(result, source) },
        source === "self" ? { triggerTurn: true } : undefined,
      );
    };

    const reviewAndRefine = async (s: SessionHarness, reason: AutoReason, signal: AbortSignal): Promise<RefineResult | undefined> => {
      const { global, local } = loadStates(s);
      const records = history(s);
      const conversation = conversationText(contextMessages(s.ctx), SKIP_IN_TRAJECTORY).slice(-REVIEW_CONVERSATION);
      const reply = await callModel(s, REVIEW_PROMPT, conversation, c => reviewPrompt(mergeStates(global, local), records, c, { reason, turnsSinceLastReview: s.turns }), NO_THINKING_REVIEW_TOKENS, signal);
      const review = parseReview(reply);
      if (!review.shouldRefine) return undefined;
      return refine(s, { instructions: autoRefineInstructions(reason, review), global: false }, signal);
    };

    /** After a run settles: a refine the agent asked for, else an auto-refine when 25 turns passed or a compaction happened. */
    const afterRun = (s: SessionHarness) => {
      if (s.requested) {
        const ask = s.requested;
        s.requested = undefined;
        let done: RefineResult | undefined;
        exclusive(s, async signal => {
          done = await refine(s, { instructions: ask.instructions, global: ask.global === true }, signal);
        })
          .then(() => done && notify(s, done, "self"))
          .catch(error => pi.sendMessage({ customType: OUTCOME_TYPE, content: `Refinement failed: ${error instanceof Error ? error.message : String(error)}`, display: true, details: { error: String(error) } }));
        return;
      }
      if (s.depth > 0 || !s.localDir) return;
      const auto = settings().autoRefine;
      if (!auto.enabled) return;
      const reason: AutoReason = s.compactPending && auto.compact ? "compact" : "turn_interval";
      if (reason === "turn_interval" && s.turns < auto.turnInterval) return;
      if (s.lastReviewAt > 0 && Date.now() - s.lastReviewAt < auto.cooldownMs) return;
      if (!s.ctx.model) return;
      let done: RefineResult | undefined;
      exclusive(s, async signal => {
        try {
          done = await reviewAndRefine(s, reason, signal);
        } finally {
          s.lastReviewAt = Date.now();
          s.turns = 0;
          s.compactPending = false;
        }
      })
        .then(() => done && notify(s, done, "auto"))
        .catch(() => undefined);
    };

    pi.on("resources_discover", () => ({ skillPaths: [skillsDir] }));

    pi.on("session_start", (_event, ctx) => {
      const id = ctx.sessionManager.getSessionId();
      const old = sessions.get(id);
      old?.dispose.forEach(f => f());
      const artifact = sessionArtifactDir(id, ctx.sessionManager.getSessionFile());
      const s: SessionHarness = {
        id,
        depth: identityOf(id, id).depth,
        localDir: artifact ? localHarnessDir(artifact) : undefined,
        globalDir: options.globalDir ?? globalHarnessDir(),
        ctx,
        turns: 0,
        lastReviewAt: 0,
        compactPending: false,
        dispose: [],
      };
      sessions.set(id, s);
      if (s.depth === 0 && s.localDir) {
        s.dispose.push(
          registerKernelHandler(id, "refine.status", () => ({ pending: s.requested !== undefined, in_flight: s.inFlight !== undefined })),
          registerKernelHandler(id, "refine.run", payload => {
            const instructions = payload.instructions;
            if (instructions !== undefined && typeof instructions !== "string") throw new Error("refine.run instructions must be a string when provided");
            const global = payload.global;
            if (global !== undefined && typeof global !== "boolean") throw new Error("refine.run global must be a boolean when provided");
            if (s.ctx.isIdle()) return { scheduled: false, reason: "no active turn; refine can only be requested while a turn is running" };
            s.requested = { instructions: instructions ?? s.requested?.instructions, global: global ?? s.requested?.global };
            return {
              scheduled: true,
              note: "Refinement runs when the current turn ends; applied edits are appended to your context as a refinement notice and you resume automatically. Continue working normally.",
            };
          }),
        );
      }
    });

    pi.on("session_shutdown", (_event, ctx) => {
      const id = ctx.sessionManager.getSessionId();
      const s = sessions.get(id);
      if (!s) return;
      s.abort?.abort();
      s.dispose.forEach(f => f());
      sessions.delete(id);
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const s = sessions.get(ctx.sessionManager.getSessionId());
      if (!s) return;
      s.ctx = ctx;
      if (s.inFlight) await s.inFlight;
      const prompt = event.messageType === "user" ? event.prompt : undefined;
      if (settings().digestRoute === "section") {
        event.systemPromptOptions.sections[SECTION] = sectionText(s, prompt);
        return;
      }
      const message = nextDigestMessage(s, prompt);
      return message ? { message } : undefined;
    });

    pi.on("context", event => {
      const messages = event.messages.filter(m => !(m.role === "custom" && (m as { customType: string }).customType === OUTCOME_TYPE));
      return messages.length === event.messages.length ? undefined : { messages };
    });

    pi.on("session_before_compact", event => {
      const keep = (m: AgentMessage) => !(m.role === "custom" && SKIP_IN_SUMMARY.has((m as { customType: string }).customType));
      for (const list of [event.preparation.messagesToSummarize, event.preparation.turnPrefixMessages]) {
        const kept = list.filter(keep);
        list.splice(0, list.length, ...kept);
      }
    });

    pi.on("message_end", (event, ctx) => {
      const s = sessions.get(ctx.sessionManager.getSessionId());
      const m = event.message as { role: string; stopReason?: string };
      if (s && m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") s.turns++;
    });

    pi.on("agent_settled", (event, ctx) => {
      const s = sessions.get(ctx.sessionManager.getSessionId());
      if (!s) return;
      s.ctx = ctx;
      if (event.aborted) {
        s.requested = undefined;
        return;
      }
      afterRun(s);
    });

    pi.on("session_compact", (_event, ctx) => {
      const s = sessions.get(ctx.sessionManager.getSessionId());
      if (!s) return;
      s.compactPending = true;
      if (ctx.isIdle()) afterRun(s);
    });

    pi.on("session_tree", (_event, ctx) => {
      const s = sessions.get(ctx.sessionManager.getSessionId());
      if (!s) return;
      s.abort?.abort();
      s.turns = 0;
      s.compactPending = false;
      s.requested = undefined;
    });

    pi.registerCommand("refine", {
      description: "Refine the continual harness: /refine [--global] [instructions], or /refine rollback <id>",
      handler: async (args, ctx) => {
        const s = sessions.get(ctx.sessionManager.getSessionId());
        if (!s) throw new Error("pi-harness has no state for this session");
        s.ctx = ctx;
        const parsed = parseRefineArgs(args);
        await ctx.waitForIdle();
        let done: RefineResult | undefined;
        try {
          await exclusive(s, async signal => {
            done = await refine(s, parsed, signal);
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          pi.sendMessage({ customType: OUTCOME_TYPE, content: `Command failed: ${message}`, display: true, details: { error: message } });
          if (ctx.hasUI) ctx.ui.notify(`Refine failed: ${message}`, "error");
          return;
        }
        if (done) {
          notify(s, done, "user");
          const applied = done.appliedEdits.filter(e => e.applied).length;
          if (ctx.hasUI) ctx.ui.notify(`Refined continual harness state: ${applied} edit${applied === 1 ? "" : "s"} applied (${done.id}).`, "info");
        }
      },
    });
  };
}

export default createHarnessExtension();
