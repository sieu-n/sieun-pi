/**
 * pi-pool as a pi-ai Provider for pi-durable. Each request asks pi-pool's token hook for the tree's account, the same
 * way the Pi extension in ../pi does, through ../core/pool-cli.ts.
 *
 * A slot wait (the hook's exit 75) becomes a deferred response, so pi-durable's generation task commits a sleep until
 * the slot and holds no request while it waits. A restart during the wait finds the sleep in storage and polls again at
 * its time. When a poll finds the slot open, the poll ends with a retryable error, and the generation's retry sends
 * the request with the new token.
 *
 * Every request also takes its run's place in this machine's turn queue (pi-pool `turns.py`), the one line that every
 * Prime and Pi run on the box waits in. A queued run is deferred the same way and polls its place; the run's slot is
 * held until `TurnQueue.release`, which pi-host calls when the conversation's input settles.
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
import { DEFAULT_RETRY_POLICY, type HarnessSettings } from "@earendil-works/pi-durable";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rewriteFailure, type PoolCall } from "../core/errors.ts";
import { admitReply, placeIn, type AdmitReply } from "../core/turns.ts";
import { defaultPoolBin, poolEnv, runPool, vendOnce, WAIT_ASK_MS, type TreeKey, type Vend } from "../core/pool-cli.ts";

export interface PoolProviderOptions {
  /** The pool tree's root key. One durable session file is one tree, so every conversation in it shares the account. */
  treeKey: string;
  /** The token hook; defaults to `PI_POOL_TOKEN_BIN` or `<pool dir>/bin/pi-pool-token`. */
  bin?: string;
  /** The agent dir whose auth.json `adopt-logins` reads. */
  agentDir?: string;
  /** The provider that sends the request with the vended token; defaults to pi-ai's anthropic provider. */
  inner?: Provider;
  /** The machine's turn queue, shared by every thread in the process; without it requests take no place in line. */
  turns?: TurnQueue;
  now?: () => number;
}

/** The deferred handle id of a slot wait. A real Anthropic response id never has this form. */
export const SLOT_HANDLE_ID = "pi-pool-slot";
/** Retry text for a poll that found the slot open; pi-ai's retry pattern matches "service is temporarily unavailable". */
export const SLOT_OPEN_TEXT = "pi-pool: the account slot is open; the service is temporarily unavailable until the retry sends the request";

/** The deferred handle id of a turn-queue wait. */
export const TURN_HANDLE_ID = "pi-pool-turn";
/** Retry text for a poll that found the run's working slot started. */
export const TURN_OPEN_TEXT = "pi-pool: the working slot is open; the service is temporarily unavailable until the retry sends the request";
/** How often a queued run reads its place, the extension's WAIT_READ_MS in ../core/turns.ts. */
export const TURN_POLL_MS = 1000;
/** How often a working run renews its slot's lease, the extension's QUEUE_RENEW_MS in ../pi/index.ts. */
export const TURN_RENEW_MS = 5 * 60_000;

/**
 * The pool-handled failures of each conversation's current run, by tree root and then session: a 429 or an account
 * refusal the pool took on, and each slot or turn wait that ends with the retryable error that sends the request. The
 * pool's routing is no failure of the run, as `@sieun-pi/pi-family/retries` says for Pi sessions. On 10-29 at 08:03 KST
 * agent factory's run met five 429s from the one account the pool had, each with a slot wait named, and pi-durable
 * ended it as failed at attempt 5, so nothing woke it again until someone sent it a message.
 */
const pooled = new Map<string, Map<string, number>>();

function countPooled(key: TreeKey): void {
  const sessions = pooled.get(key.root) ?? new Map<string, number>();
  sessions.set(key.session, (sessions.get(key.session) ?? 0) + 1);
  pooled.set(key.root, sessions);
}

function clearPooled(key: TreeKey): void {
  const sessions = pooled.get(key.root);
  sessions?.delete(key.session);
  if (sessions?.size === 0) pooled.delete(key.root);
}

/** The most pool-handled retries any run of the tree has now. The budget is per file, so it follows its busiest run. */
export function pooledRetries(root: string): number {
  const sessions = pooled.get(root);
  return sessions ? Math.max(0, ...sessions.values()) : 0;
}

/**
 * Run settings for the thread behind `treeKey`: pi-durable's retry budget for real request failures, plus each
 * pool-handled retry of the tree's busiest run, read at every retry, so a run that waits on the pool waits as long as
 * the pool says and still fails after pi-durable's own count of other errors.
 */
export function durableSettings(treeKey: string, retry: Partial<typeof DEFAULT_RETRY_POLICY> = {}): HarnessSettings {
  const base = { ...DEFAULT_RETRY_POLICY, ...retry };
  return { get retry() { return { ...base, maxRetries: base.maxRetries + pooledRetries(treeKey) }; } };
}

type TurnPlace = { kind: "go" } | { kind: "wait"; position: number | null; total: number | null; askedAt: number };

/**
 * Where one session stands in turns.json: holding a working slot, queued at a place (lead sessions first, then first
 * asked, as `order` in pool/turns.py), marked for an owner turn its next admit takes at once, or not in the queue.
 */
export type TicketPlace =
  | { state: "working"; kind: string | null }
  | { state: "queued"; position: number; total: number }
  | { state: "marked" }
  | { state: "none" };

/** A run's ticket in pi-pool's turn queue: the session that asks, its tree, and its place. */
export interface TurnTicket { session: string; tree: string; place: TicketPlace }

/** `pi-pool owner-turn`'s answer: marked, with `ahead` when a queued run of the session started; off while the queue is off. */
export interface OwnerMark { state: "marked" | "off" | "failed"; ahead?: boolean }

interface TurnsFile {
  working?: Record<string, { kind?: unknown }>;
  queued?: Record<string, { since?: unknown; parked?: unknown }>;
  owner?: Record<string, unknown>;
  lead?: unknown;
}

/** The ticket of `key` in turns.json text; a file that cannot be read or parsed reads as an empty queue. */
export function ticketIn(text: string | undefined, key: TreeKey): TurnTicket {
  let turns: TurnsFile = {};
  try {
    const parsed = text ? (JSON.parse(text) as TurnsFile | null) : null;
    if (parsed && typeof parsed === "object") turns = parsed;
  } catch {
    turns = {};
  }
  const ticket = (place: TicketPlace): TurnTicket => ({ session: key.session, tree: key.root, place });
  const working = turns.working?.[key.session];
  if (working) return ticket({ state: "working", kind: typeof working.kind === "string" ? working.kind : null });
  const queued = turns.queued ?? {};
  if (queued[key.session]) {
    const lead = new Set(Array.isArray(turns.lead) ? turns.lead : []);
    const rank = (s: string): [number, number, string] => [lead.has(s) ? 0 : 1, Number(queued[s]?.since ?? 0), s];
    const order = Object.keys(queued).sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
    });
    return ticket({ state: "queued", position: order.indexOf(key.session) + 1, total: order.length });
  }
  return ticket(turns.owner && key.session in turns.owner ? { state: "marked" } : { state: "none" });
}

/**
 * One process's view of pi-pool's turn queue: which sessions hold a working slot, asking with `admit`, renewing with
 * `admit --renew` and letting go with `release`, as the pi-pool Pi extension does for a Pi session. A failed or
 * unreadable ask lets the run go, as the extension does.
 */
export class TurnQueue {
  private readonly held = new Map<string, number>();
  readonly bin: string;
  readonly turnsFile: string;

  constructor(private readonly opts: { bin?: string; agentDir?: string; turnsFile?: string; now?: () => number } = {}) {
    this.bin = opts.bin ?? defaultPoolBin();
    this.turnsFile = opts.turnsFile ?? join(process.env.PI_POOL_DIR || join(homedir(), ".config", "pi-pool"), "turns.json");
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async call(key: TreeKey, args: string[]): Promise<{ ok: boolean; out: string }> {
    const run = await runPool(this.bin, ["--cli", ...args], poolEnv(key, this.opts.agentDir));
    return { ok: run.code === 0, out: run.stdout.trim() || run.stderr.trim() };
  }

  private async ask(key: TreeKey): Promise<TurnPlace> {
    const res = await this.call(key, ["admit", key.session]);
    const reply: AdmitReply | null = res.ok ? admitReply(res.out) : null;
    if (reply?.state === "queued") return { kind: "wait", position: reply.position, total: reply.total, askedAt: this.now() };
    if (reply?.state === "admitted") this.held.set(key.session, this.now());
    return { kind: "go" };
  }

  /** Before a request: go when the session holds its slot (renewing its lease when due), else ask for one. */
  async enter(key: TreeKey): Promise<TurnPlace> {
    const renewedAt = this.held.get(key.session);
    if (renewedAt === undefined) return this.ask(key);
    if (this.now() - renewedAt >= TURN_RENEW_MS) {
      this.held.set(key.session, this.now());
      await this.call(key, ["admit", key.session, "--renew"]);
    }
    return { kind: "go" };
  }

  /** At a queued run's poll: an unlocked read of turns.json, and a real ask every WAIT_ASK_MS or when the entry is gone. */
  async poll(key: TreeKey, askedAt: number): Promise<TurnPlace> {
    let place: ReturnType<typeof placeIn> = null;
    try {
      place = placeIn(readFileSync(this.turnsFile, "utf8"), key.session);
    } catch {
      place = null;
    }
    if (place?.part === "working") {
      this.held.set(key.session, this.now());
      return { kind: "go" };
    }
    if (place?.part === "queued" && this.now() - askedAt < WAIT_ASK_MS) return { kind: "wait", position: null, total: null, askedAt };
    return this.ask(key);
  }

  /** After the session's input settled: give the slot back; `queuedInput` keeps the place for a run that starts at once. */
  async release(key: TreeKey, queuedInput = false): Promise<void> {
    this.held.delete(key.session);
    await this.call(key, ["release", key.session, ...(queuedInput ? ["--queued-input"] : [])]);
  }

  /**
   * The owner's input goes to `key.session` next: `pi-pool owner-turn` marks the session's next admit as the owner's,
   * which starts at once, and a run of the session already queued starts now, as the chat marks an owner prompt to Prime.
   */
  async ownerTurn(key: TreeKey): Promise<OwnerMark> {
    const res = await this.call(key, ["owner-turn", key.session]);
    try {
      const answer = JSON.parse(res.out.split("\n").at(-1) ?? "") as { state?: unknown; ahead?: unknown };
      if (res.ok && (answer.state === "marked" || answer.state === "off")) return { state: answer.state, ...(answer.ahead === true ? { ahead: true } : {}) };
    } catch {
      // An answer that is not JSON is a failed mark; the run still asks for its slot at its first request.
    }
    return { state: "failed" };
  }

  /** The session's ticket from an unlocked read of turns.json, as `poll` reads it. */
  ticket(key: TreeKey): TurnTicket {
    let text: string | undefined;
    try {
      text = readFileSync(this.turnsFile, "utf8");
    } catch {
      text = undefined;
    }
    return ticketIn(text, key);
  }

  holds(session: string): boolean {
    return this.held.has(session);
  }
}

function turnWait(model: Model<Api>, key: TreeKey, place: Extract<TurnPlace, { kind: "wait" }>): AssistantMessage {
  const deferred: DeferredHandle = {
    provider: model.provider, modelId: model.id, api: model.api, id: TURN_HANDLE_ID, pollAfterMs: TURN_POLL_MS,
    data: { session: key.session, askedAt: place.askedAt, position: place.position, total: place.total },
  };
  return message(model, { stopReason: "deferred", deferred });
}

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
function slotWait(model: Model<Api>, key: TreeKey, wait: Extract<Vend, { kind: "wait" }>, now: number): AssistantMessage {
  const pollAfterMs = Math.min(Math.max(1000, wait.retryAt * 1000 - now), WAIT_ASK_MS);
  const deferred: DeferredHandle = { provider: model.provider, modelId: model.id, api: model.api, id: SLOT_HANDLE_ID, pollAfterMs, data: { session: key.session, retryAt: wait.retryAt, message: wait.message } };
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
        const place = opts.turns ? await opts.turns.enter(keyOf(options)) : ({ kind: "go" } as const);
        const got = place.kind === "wait" ? undefined : await vendOnce(bin, model.provider, env, options?.signal);
        if (place.kind === "wait" || got === undefined) final = turnWait(model, keyOf(options), place as Extract<TurnPlace, { kind: "wait" }>);
        else if (options?.signal?.aborted) final = message(model, { stopReason: "aborted", errorMessage: "Request aborted" });
        else if (got.kind === "wait") final = slotWait(model, keyOf(options), got, now());
        else if (got.kind === "failed") final = noToken(model, got.reason);
        else {
          const events = run({ ...options, apiKey: got.token } as O);
          for await (const event of events as AsyncIterable<AssistantMessageEvent>) {
            if (event.type !== "done" && event.type !== "error") out.push(event);
          }
          const result = await events.result();
          final = (await rewriteFailure(result, callOf(env), undefined, now, () => countPooled(keyOf(options)))) ?? result;
        }
      } catch (error) {
        final = message(model, { stopReason: "error", errorMessage: `pi-pool: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (final.stopReason === "stop" || final.stopReason === "length" || final.stopReason === "toolUse") clearPooled(keyOf(options));
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
    // Only slot and turn waits are deferred here: a poll asks the pool again, and an open slot ends the poll with a retryable error.
    fetchDeferred: (model, handle, options) => {
      if (handle.id === TURN_HANDLE_ID) {
        const out = createAssistantMessageEventStream();
        void (async () => {
          // The poll's options carry no session id, so the wait's handle names the session that asked.
          const data = (handle.data ?? {}) as { session?: unknown; askedAt?: unknown };
          const key: TreeKey = { root: opts.treeKey, session: typeof data.session === "string" ? data.session : keyOf(options).session };
          const place = opts.turns ? await opts.turns.poll(key, Number(data.askedAt ?? 0)) : ({ kind: "go" } as const);
          if (place.kind !== "wait") countPooled(key);
          const final = place.kind === "wait" ? turnWait(model, key, place) : message(model, { stopReason: "error", errorMessage: TURN_OPEN_TEXT });
          for await (const event of ended(final) as AsyncIterable<AssistantMessageEvent>) out.push(event);
          out.end(final);
        })();
        return out;
      }
      if (handle.id !== SLOT_HANDLE_ID) return ended(message(model, { stopReason: "error", errorMessage: `pi-pool: unknown deferred handle ${handle.id}` }));
      const out = createAssistantMessageEventStream();
      void (async () => {
        // The poll's options carry no session id, so the wait's handle names the session that asked.
        const data = (handle.data ?? {}) as { session?: unknown };
        const key: TreeKey = { root: opts.treeKey, session: typeof data.session === "string" ? data.session : keyOf(options).session };
        const got = await vendOnce(bin, model.provider, poolEnv(key, opts.agentDir), options?.signal);
        if (got.kind === "token") countPooled(key);
        const final = got.kind === "wait" ? slotWait(model, key, got, now()) : got.kind === "failed" ? noToken(model, got.reason) : message(model, { stopReason: "error", errorMessage: SLOT_OPEN_TEXT });
        const replay = ended(final);
        for await (const event of replay as AsyncIterable<AssistantMessageEvent>) out.push(event);
        out.end(final);
      })();
      return out;
    },
    cancelDeferred: async () => {},
  };
}
