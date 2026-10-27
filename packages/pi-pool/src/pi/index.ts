/**
 * pi-pool on upstream Pi. Every request on a pooled provider gets its account from pi-pool's own token hook,
 * asked as a client for this session's tree, so many sessions in one pi-host each get their tree's account.
 *
 * Anthropic vends in before_provider_headers. openai-codex vends in a stream wrapper, because Pi's codex provider
 * writes Authorization and chatgpt-account-id from its apiKey after the caller's headers. A slot wait (the hook's
 * exit 75) waits inside that call until the slot, and Escape ends it. A 429 or an account-level refusal becomes a
 * retryable error in message_end, so Pi's own retry vends again and the pool moves the tree to its next account.
 */
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model, Api, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
// Pi's extension loader aliases only a few pi-ai entry points, so this file imports pi-ai through `compat` alone.
import { createAssistantMessageEventStream, openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { PRIME_BASE_PROMPT } from "@sieun-pi/pi-family/preamble";
import { identityOf } from "@sieun-pi/pi-family/registry";
import { accountCommand, POOLED_PROVIDERS, refreshStatus, STATUS_REFRESH_MS } from "../core/account.ts";
import { rewriteFailure, type PoolCall } from "../core/errors.ts";
import { credential, defaultPoolBin, poolEnv, runPool, vendOnce, type TreeKey } from "../core/pool-cli.ts";
import { clearPoolRetries, countPoolRetry } from "@sieun-pi/pi-family/retries";
import { admitWait, ordinal } from "../core/turns.ts";

export interface PoolOptions {
  /** The token hook; defaults to `PI_POOL_TOKEN_BIN` or `<pool dir>/bin/pi-pool-token`. */
  bin?: string;
  /** The turn queue file the wait reads without the lock; defaults to `<pool dir>/turns.json`. */
  turnsFile?: string;
  /** The agent dir whose auth.json `adopt-logins` reads; defaults to Pi's own. */
  agentDir?: string;
  /** The codex streams the wrapper calls with the vended key; tests pass a stand-in. */
  codex?: { streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream };
}

/** An OAuth-shaped key, so Pi's anthropic provider takes its OAuth path; the header hook replaces it on every request. */
export const ANTHROPIC_PLACEHOLDER = "sk-ant-oat01-pi-pool-vends-each-request";
const CODEX_PLACEHOLDER = "pi-pool-vends-each-request";
const WAIT_KEY = "pi-pool-wait";
const QUEUE_ENTRY = "pi-pool-queue";
// Six renewals per lease_s of 1,800 s, so a run that calls the model at least once per 25 minutes never lapses.
const QUEUE_RENEW_MS = 5 * 60_000;

/** One session the extension serves, on globalThis so the codex wrapper finds it by the request's sessionId. */
interface PoolSession {
  key: TreeKey;
  env: NodeJS.ProcessEnv;
  /** Why the header hook gave this request no token; message_end reads and clears it. */
  hookFailure?: string;
  /** The slot wait shown to people and to pi-host's roster, or undefined. */
  waiting?: string;
  showWait(text: string | undefined): void;
}
const SESSIONS: unique symbol = Symbol.for("sieun-pi.pi-stack.pool.sessions");
const g = globalThis as typeof globalThis & { [SESSIONS]?: Map<string, PoolSession> };
const sessions = (g[SESSIONS] ??= new Map());

/** What pi-host reads to show a session that waits for an account slot or a working slot. */
export function poolWait(sessionId: string): string | undefined {
  return sessions.get(sessionId)?.waiting;
}

/** The root of `sessionId`'s tree, through the parent links pi-rlm assigns before it opens a child. */
export function rootOf(sessionId: string): string {
  let id = sessionId;
  for (let hops = 0; hops < 64; hops++) {
    const parent = identityOf(id, id).parentId;
    if (!parent) return id;
    id = parent;
  }
  return id;
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
  try {
    const id = ctx.sessionManager.getSessionId();
    return id || undefined;
  } catch {
    return undefined;
  }
}

/** A person sees this session's footer: a UI is bound and the session is no RLM child. */
function showsStatus(ctx: ExtensionContext, sid: string): boolean {
  return ctx.hasUI && identityOf(sid, sid).depth === 0;
}

function callFor(bin: string, env: NodeJS.ProcessEnv): PoolCall {
  return async args => {
    const run = await runPool(bin, ["--cli", ...args], env);
    // The CLI reports its own refusals on stdout and exits non-zero, so stdout carries the message either way.
    const out = run.stdout.trim() || run.stderr.trim();
    return { ok: run.code === 0, out: out || (run.code === 0 ? "" : "pi-pool-token failed") };
  };
}

function failedMessage(model: Model<Api>, stopReason: "error" | "aborted", errorMessage: string): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, errorMessage, timestamp: Date.now(),
  };
}

export function createPoolExtension(opts: PoolOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const bin = opts.bin ?? defaultPoolBin();
    const turnsFile = opts.turnsFile ?? join(process.env.PI_POOL_DIR || join(process.env.HOME ?? "", ".config", "pi-pool"), "turns.json");
    const agentDir = opts.agentDir ?? getAgentDir();
    const anyPool = callFor(bin, poolEnv(undefined, agentDir));
    const codex = opts.codex ?? openAICodexResponsesApi();
    const own = new Set<string>();

    const session = (ctx: ExtensionContext): PoolSession | undefined => {
      const sid = sessionIdOf(ctx);
      if (!sid) return undefined;
      let s = sessions.get(sid);
      if (!s) {
        const key = { root: rootOf(sid), session: sid };
        const made: PoolSession = {
          key,
          env: poolEnv(key, agentDir),
          showWait: text => {
            made.waiting = text;
            try {
              ctx.ui.setStatus(WAIT_KEY, text);
            } catch {
              // A replaced session's ctx throws; its wait is over.
            }
          },
        };
        s = made;
        sessions.set(sid, s);
        own.add(sid);
      }
      return s;
    };
    const call = (ctx: ExtensionContext): PoolCall => {
      const s = session(ctx);
      return callFor(bin, s ? s.env : poolEnv(undefined, agentDir));
    };
    const slotText = (wait: { retryAt: number } | undefined) =>
      wait ? `pi-pool: waiting for an account slot at ${new Date(wait.retryAt * 1000).toISOString()}` : undefined;

    pi.registerProvider("anthropic", { apiKey: ANTHROPIC_PLACEHOLDER });
    pi.registerProvider("openai-codex", {
      apiKey: CODEX_PLACEHOLDER,
      api: "openai-codex-responses",
      streamSimple: (model, context, options) => {
        const out = createAssistantMessageEventStream();
        void (async () => {
          const s = options?.sessionId ? sessions.get(options.sessionId) : undefined;
          if (!s) {
            const m = failedMessage(model, "error", "pi-pool: this request names no pool session, so the pool has no account for it.");
            out.push({ type: "error", reason: "error", error: m });
            out.end(m);
            return;
          }
          const got = await credential(signal => vendOnce(bin, "openai-codex", s.env, signal), options?.signal, wait => s.showWait(slotText(wait)));
          if (got.kind !== "token") {
            const m = got.kind === "aborted"
              ? failedMessage(model, "aborted", "Request aborted")
              : failedMessage(model, "error", `pi-pool: the token hook gave no token (${got.reason}); the service is temporarily unavailable and the retry runs the hook again.`);
            out.push({ type: "error", reason: m.stopReason as "error" | "aborted", error: m });
            out.end(m);
            return;
          }
          let last: AssistantMessage | undefined;
          for await (const event of codex.streamSimple(model, context, { ...options, apiKey: got.token }) as AsyncIterable<AssistantMessageEvent>) {
            if (event.type === "done") last = event.message;
            if (event.type === "error") last = event.error;
            out.push(event);
          }
          out.end(last);
        })();
        return out;
      },
    });

    pi.on("before_provider_headers", async (event, ctx) => {
      if (ctx.model?.provider !== "anthropic") return;
      const s = session(ctx);
      if (!s) return;
      s.hookFailure = undefined;
      const got = await credential(signal => vendOnce(bin, "anthropic", s.env, signal), ctx.signal, wait => s.showWait(slotText(wait)));
      if (got.kind === "token") {
        event.headers.authorization = `Bearer ${got.token}`;
        event.headers["x-api-key"] = null;
      } else if (got.kind === "failed") {
        s.hookFailure = got.reason;
        event.headers.authorization = "Bearer pi-pool-gave-no-token";
      }
    });

    // Anthropic refuses a subscription token under Pi's default preamble (pi-family/preamble.ts), so pooled sessions get Prime's.
    pi.on("before_agent_start", async (event, ctx) => {
      if (ctx.model?.provider !== "anthropic") return;
      const options = event.systemPromptOptions;
      if (!options.customPrompt && !options.forceSystemPrompt) options.customPrompt = PRIME_BASE_PROMPT;
    });

    pi.on("message_end", async (event, ctx) => {
      const message = event.message;
      if (message.role !== "assistant" || !POOLED_PROVIDERS.has(message.provider)) return undefined;
      // Stop during a slot wait ends the wait, and Pi then reports the run's own abort ("This operation was aborted") as an error. It is the
      // owner's stop, so it ends as one and the chat shows "Response stopped" (the 10-27 walk on pi-host showed the error text).
      if (message.stopReason === "error" && ctx.signal?.aborted) return { message: { ...message, stopReason: "aborted", errorMessage: "Request aborted" } };
      const s = session(ctx);
      const sid = sessionIdOf(ctx);
      if (message.stopReason !== "error") {
        if (sid) clearPoolRetries(sid);
        return undefined;
      }
      const hookFailure = s?.hookFailure;
      if (s) s.hookFailure = undefined;
      const rewritten = await rewriteFailure(message, call(ctx), hookFailure, Date.now, () => { if (sid) countPoolRetry(sid); });
      return rewritten ? { message: rewritten } : undefined;
    });

    // The turn queue. A run takes a working slot at its first model call, keeps it until agent_end and renews its lease
    // from its model calls; a timer gives the slot back when it finds the session idle, because agent_end does not fire
    // on some aborts. A failed admit lets the run go.
    type Slot = "none" | "held" | "free" | "failed" | Promise<void>;
    const queue = new Map<string, { slot: Slot; cancel: () => void; renew?: ReturnType<typeof setInterval>; renewedAt: number }>();
    const queueOf = (sid: string) => {
      let q = queue.get(sid);
      if (!q) queue.set(sid, (q = { slot: "none", cancel: () => {}, renewedAt: 0 }));
      return q;
    };
    const dropSlot = async (ctx: ExtensionContext, sid: string, next = false): Promise<void> => {
      const q = queueOf(sid);
      const owes = q.slot === "held" || q.slot === "failed";
      if (typeof q.slot === "object") q.cancel();
      q.slot = "none";
      if (q.renew) clearInterval(q.renew);
      q.renew = undefined;
      if (!owes) return;
      const pool = call(ctx);
      if (next && (await pool(["release", sid, "--queued-input"])).ok) return;
      await pool(["release", sid]);
    };
    const holdSlot = async (ctx: ExtensionContext, sid: string): Promise<void> => {
      const q = queueOf(sid);
      if (q.slot === "free" || q.slot === "failed") return;
      const pool = call(ctx);
      if (q.slot === "held") {
        if (Date.now() - q.renewedAt < QUEUE_RENEW_MS) return;
        q.renewedAt = Date.now();
        await pool(["admit", sid, "--renew"]);
        return;
      }
      if (q.slot !== "none") return q.slot;
      const s = session(ctx);
      let told = false;
      const wait = admitWait(pool, turnsFile, sid, ctx.signal, reply => {
        const { position, total } = reply;
        s?.showWait(position === null || total === null ? "pi-pool: waiting for a working slot" : `pi-pool: waiting for a working slot, place ${position} of ${total}`);
        if (told || position === null || total === null) return;
        told = true;
        const text = `Queued for a working slot, ${ordinal(position)} of ${total}`;
        try {
          pi.appendEntry(QUEUE_ENTRY, { text, position, total, at: Date.now() });
          if (showsStatus(ctx, sid)) ctx.ui.notify(`pi-pool: ${text}`, "info");
        } catch {
          wait.cancel();
        }
      });
      q.cancel = wait.cancel;
      const waiting: Promise<void> = wait.result.then(result => {
        s?.showWait(undefined);
        if (q.slot !== waiting) return;
        if (result === "stopped") {
          q.slot = "none";
          return;
        }
        q.slot = result === "failed" ? "failed" : result.state === "admitted" ? "held" : "free";
        if (q.slot !== "held") return;
        q.renewedAt = Date.now();
        q.renew = setInterval(() => {
          let idle = true;
          try {
            idle = ctx.isIdle();
          } catch {
            // A replaced session's ctx throws: its run is over.
          }
          if (idle) void dropSlot(ctx, sid);
        }, QUEUE_RENEW_MS);
      });
      q.slot = waiting;
      return waiting;
    };

    const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
    const clearTimers = (sid: string) => {
      for (const timer of timers.get(sid) ?? []) clearTimeout(timer);
      timers.delete(sid);
    };
    const recordModel = async (ctx: ExtensionContext, model = ctx.model) => {
      const sid = sessionIdOf(ctx);
      if (!sid) return;
      await call(ctx)(model && POOLED_PROVIDERS.has(model.provider) ? ["model", model.id, "--provider", model.provider, "--source", sid] : ["model", "--clear", "--source", sid]);
    };
    // The start work runs off session_start, so a session opens at once, and the first model call awaits it.
    const started = new Map<string, Promise<void>>();
    pi.on("session_start", async (_event, ctx) => {
      const sid = sessionIdOf(ctx);
      if (!sid) return;
      clearTimers(sid);
      session(ctx);
      started.set(sid, (async () => {
        const pool = call(ctx);
        // A /login for a pooled provider in Pi's auth.json would refresh a pool account's token on its own and break the
        // pool's copy, so it moves into the pool's fallback.
        const adopted = await pool(["adopt-logins"]);
        if (adopted.out && showsStatus(ctx, sid)) ctx.ui.notify(`pi-pool: ${adopted.out}`, adopted.ok ? "info" : "warning");
        await recordModel(ctx);
        void pool(["probe"]);
        if (!showsStatus(ctx, sid)) return;
        await refreshStatus(ctx, pool);
        timers.set(sid, [setInterval(() => void refreshStatus(ctx, pool), STATUS_REFRESH_MS)]);
      })().catch(() => {}));
    });
    pi.on("context", async (_event, ctx) => {
      // Only a pooled provider's run spends a pool account, so only its runs take a working slot.
      if (!ctx.model || !POOLED_PROVIDERS.has(ctx.model.provider)) return undefined;
      const sid = sessionIdOf(ctx);
      if (!sid) return undefined;
      await started.get(sid);
      await holdSlot(ctx, sid);
      return undefined;
    });
    pi.on("agent_end", async (_event, ctx) => {
      const sid = sessionIdOf(ctx);
      if (!sid) return;
      let pending = false;
      try {
        pending = ctx.hasPendingMessages();
      } catch {
        // A replaced ctx has nothing queued.
      }
      await dropSlot(ctx, sid, pending);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      const sid = sessionIdOf(ctx);
      if (!sid) return;
      clearTimers(sid);
      await dropSlot(ctx, sid);
      await call(ctx)(["model", "--clear", "--source", sid]);
      queue.delete(sid);
      started.delete(sid);
      clearPoolRetries(sid);
      if (own.delete(sid)) sessions.delete(sid);
    });
    pi.on("model_select", async (event, ctx) => {
      await recordModel(ctx, event.model);
      const sid = sessionIdOf(ctx);
      if (sid && showsStatus(ctx, sid)) await refreshStatus(ctx, call(ctx), true);
    });
    pi.on("turn_end", async (_event, ctx) => {
      const sid = sessionIdOf(ctx);
      if (sid && showsStatus(ctx, sid)) await refreshStatus(ctx, call(ctx));
    });

    pi.registerCommand("account", accountCommand(call, sessionIdOf, anyPool));
  };
}

export default function piPool(pi: ExtensionAPI): void {
  createPoolExtension()(pi);
}
