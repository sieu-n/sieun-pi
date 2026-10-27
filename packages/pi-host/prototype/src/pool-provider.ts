/**
 * pi-pool as a pi-ai Provider for pi-durable. Each request asks pi-pool's token hook for the tree's account, the same
 * way the Pi extension in ../pool does, through ../pool/src/pool-cli.ts.
 *
 * A slot wait (the hook's exit 75) becomes a deferred response, so pi-durable's generation task commits a sleep until
 * the slot and holds no request while it waits. A restart during the wait finds the sleep in storage and polls again at
 * its time. When a poll finds the slot open, the poll ends with a retryable error, and the generation's retry sends
 * the request with the new token.
 */
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type DeferredHandle,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { rewriteFailure, type PoolCall } from "../../../pi-pool/src/errors.ts";
import { defaultPoolBin, poolEnv, runPool, vendOnce, WAIT_ASK_MS, type TreeKey, type Vend } from "../../../pi-pool/src/pool-cli.ts";

export interface PoolProviderOptions {
  /** The pool tree's root key. One durable session file is one tree, so every conversation in it shares the account. */
  treeKey: string;
  /** The token hook; defaults to `PI_POOL_TOKEN_BIN` or `<pool dir>/bin/pi-pool-token`. */
  bin?: string;
  /** The agent dir whose auth.json `adopt-logins` reads. */
  agentDir?: string;
  /** The provider that sends the request with the vended token; defaults to pi-ai's anthropic provider. */
  inner?: Provider;
  now?: () => number;
}

/** The deferred handle id of a slot wait. A real Anthropic response id never has this form. */
export const SLOT_HANDLE_ID = "pi-pool-slot";
/** Retry text for a poll that found the slot open; pi-ai's retry pattern matches "service is temporarily unavailable". */
export const SLOT_OPEN_TEXT = "pi-pool: the account slot is open; the service is temporarily unavailable until the retry sends the request";

function message(model: Model<Api>, fields: Partial<AssistantMessage> & Pick<AssistantMessage, "stopReason">): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(), ...fields,
  };
}

function ended(final: AssistantMessage): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  out.push({ type: "start", partial: { ...final, content: [] } });
  if (final.stopReason === "error" || final.stopReason === "aborted") out.push({ type: "error", reason: final.stopReason, error: final });
  else out.push({ type: "done", reason: final.stopReason as "stop" | "length" | "toolUse" | "deferred", message: final });
  out.end(final);
  return out;
}

/** The deferred message of a slot wait, polled again at the slot or after WAIT_ASK_MS, whichever is first. */
function slotWait(model: Model<Api>, wait: Extract<Vend, { kind: "wait" }>, now: number): AssistantMessage {
  const pollAfterMs = Math.min(Math.max(1000, wait.retryAt * 1000 - now), WAIT_ASK_MS);
  const deferred: DeferredHandle = { provider: model.provider, modelId: model.id, api: model.api, id: SLOT_HANDLE_ID, pollAfterMs, data: { retryAt: wait.retryAt, message: wait.message } };
  return message(model, { stopReason: "deferred", deferred });
}

function noToken(model: Model<Api>, reason: string): AssistantMessage {
  return message(model, { stopReason: "error", errorMessage: `pi-pool: the token hook gave no token (${reason}); the service is temporarily unavailable and the retry runs the hook again.` });
}

export function poolProvider(opts: PoolProviderOptions): Provider {
  const inner = opts.inner ?? anthropicProvider();
  const bin = opts.bin ?? defaultPoolBin();
  const now = opts.now ?? Date.now;
  const keyOf = (options: StreamOptions | undefined): TreeKey => ({ root: opts.treeKey, session: options?.sessionId ?? opts.treeKey });
  const envOf = (options: StreamOptions | undefined) => poolEnv(keyOf(options), opts.agentDir);
  const callOf = (env: NodeJS.ProcessEnv): PoolCall => async args => {
    const run = await runPool(bin, ["--cli", ...args], env);
    const out = run.stdout.trim() || run.stderr.trim();
    return { ok: run.code === 0, out: out || (run.code === 0 ? "" : "pi-pool-token failed") };
  };

  /** Vends, then streams through `inner` with the token; a 429 or an account refusal goes back to the pool as in ../pool. */
  const send = <O extends StreamOptions>(model: Model<Api>, options: O | undefined, run: (options: O) => AssistantMessageEventStream): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      const env = envOf(options);
      let final: AssistantMessage;
      try {
        const got = await vendOnce(bin, model.provider, env, options?.signal);
        if (options?.signal?.aborted) final = message(model, { stopReason: "aborted", errorMessage: "Request aborted" });
        else if (got.kind === "wait") final = slotWait(model, got, now());
        else if (got.kind === "failed") final = noToken(model, got.reason);
        else {
          const events = run({ ...options, apiKey: got.token } as O);
          for await (const event of events as AsyncIterable<AssistantMessageEvent>) {
            if (event.type !== "done" && event.type !== "error") out.push(event);
          }
          const result = await events.result();
          final = (await rewriteFailure(result, callOf(env), undefined, now)) ?? result;
        }
      } catch (error) {
        final = message(model, { stopReason: "error", errorMessage: `pi-pool: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (final.stopReason === "error" || final.stopReason === "aborted") out.push({ type: "error", reason: final.stopReason, error: final });
      else out.push({ type: "done", reason: final.stopReason as "stop" | "length" | "toolUse" | "deferred", message: final });
      out.end(final);
    })();
    return out;
  };

  return {
    id: inner.id,
    name: `${inner.name} through pi-pool`,
    baseUrl: inner.baseUrl,
    headers: inner.headers,
    // The pool vends each request's token, so the provider is always configured and Models adds no credential.
    auth: { apiKey: { name: "pi-pool", resolve: async () => ({ auth: {}, source: "pi-pool" }) } },
    getModels: () => inner.getModels(),
    stream: (model, context, options) => send(model, options, o => inner.stream(model, context, o)),
    streamSimple: (model, context, options) => send(model, options, o => inner.streamSimple(model, context, o)),
    // Only slot waits are deferred here: a poll asks the pool again, and an open slot ends the poll with a retryable error.
    fetchDeferred: (model, handle, options) => {
      if (handle.id !== SLOT_HANDLE_ID) return ended(message(model, { stopReason: "error", errorMessage: `pi-pool: unknown deferred handle ${handle.id}` }));
      const out = createAssistantMessageEventStream();
      void (async () => {
        const got = await vendOnce(bin, model.provider, envOf(options), options?.signal);
        const final = got.kind === "wait" ? slotWait(model, got, now()) : got.kind === "failed" ? noToken(model, got.reason) : message(model, { stopReason: "error", errorMessage: SLOT_OPEN_TEXT });
        const replay = ended(final);
        for await (const event of replay as AsyncIterable<AssistantMessageEvent>) out.push(event);
        out.end(final);
      })();
      return out;
    },
    cancelDeferred: async () => {},
  };
}
