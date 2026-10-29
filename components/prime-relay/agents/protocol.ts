/**
 * The agent relay's link to the chat server (apps/chat/docs/agent-model.md, section 4 and phase 6): one WebSocket per box at
 * `ws://<box>:<agentRelayPort>/v2/agents`, which the chat server dials with the box's bearer token from ~/.config/sieun-pi/hosts.json.
 * Each WebSocket text message is one JSON frame below. The relay holds one pi-host socket per link, so a dropped link drops its watches
 * and feed stream, and the chat server sets them up again after the next `hello`.
 *
 * 1. The relay sends `hello` first. The server answers `welcome` with the feed cursor it saved for this box, and the relay starts pi-host's
 *    `durable_feed` after it.
 * 2. The server sends `call` frames. An op in `DURABLE_OPS` goes to pi-host as that command with `args` as its fields, and its answer comes
 *    back as `result`. `watch` and `unwatch` open and close a `durable_watch`, whose events come back as `watch_event` under the server's
 *    own watch id. `check` runs a wake's shell check on this box.
 * 3. pi-host's feed rows come up as `event` frames in seq order. The server reads the posts they name and answers `ack`.
 * 4. A thread on this box reaches the chat server's HTTP API through the relay's local port (`chatProxy`), which goes up as a `call` with op
 *    `chat_http`, and the server answers with `result`.
 *
 * Idempotency is per hop: a delivery is a `durable_submit` with requestId `d:<post>:<agent>` (or `b:<first post>:<agent>` for a bundle),
 * which pi-host keeps once, and a speaking call's post has requestId `m:<thread>:<toolCallId>`, which the chat server stores once.
 */

/** The relay protocol's version; `hello` carries it, and the server refuses a relay with another major. */
export const AGENT_RELAY_PROTOCOL = 1;
export const AGENT_RELAY_PATH = "/v2/agents";

/** pi-host commands the relay passes through as they are (packages/pi-host/src/durable/commands.ts). */
export const DURABLE_OPS = [
  "durable_threads", "durable_create", "durable_submit", "durable_wait", "durable_abort", "durable_tree", "durable_entries", "durable_search",
  "durable_usage", "durable_doc_get", "durable_doc_put", "durable_set", "durable_import", "durable_ticket",
] as const;
export type DurableOp = (typeof DURABLE_OPS)[number];

/** One speaking call (`send_message` or `tell_owner`) whose result went out, as pi-host's `durable_feed` gives it. */
export interface FeedRow {
  /** pi-host's outbox row id; it only grows. */
  seq: number;
  thread: string;
  conversation: number;
  /** The assistant entry that holds the call. */
  entry: number;
  toolCallId: string;
  toolName: string;
  /** `m:<thread>:<toolCallId>`, the post's dedup key. */
  requestId: string;
  text: string;
  to?: string;
  why?: string;
  at: number;
}

/** A shell check of a check wake, run on the box whose thread armed it; the shape of legacy wakes.ts `CheckResult`. */
export interface CheckArgs { command: string; timeoutMs: number }

/** A thread's call into the chat server's HTTP API, through the relay's local port. */
export interface ChatHttpArgs { method: string; path: string; headers?: Record<string, string>; body?: string }
export interface ChatHttpResult { status: number; headers: Record<string, string>; body: string }

/** What a box tells the server about itself, so the server can make threads there: its home, project checkouts and agent folders. */
export interface BoxInfo {
  box: string;
  platform: string;
  home: string;
  /** The project checkouts that exist on this box, the default first. */
  projects: string[];
  /** Where agent folders live on this box (`~/.pi/agent/agents`). */
  agentsDir: string;
}

export type ServerOp = DurableOp | "watch" | "unwatch" | "check" | "box_info" | "file_get" | "file_put";
export type RelayOp = "chat_http";

export type RelayFrame =
  | { type: "hello"; protocol: number; box: string; version: string; piHost: { up: boolean; version?: string; error?: string }; info: BoxInfo }
  | { type: "result"; id: string; ok: true; data: unknown }
  | { type: "result"; id: string; ok: false; error: string; /** True when pi-host never got the command, so a retry cannot act twice. */ unsent?: boolean }
  | { type: "watch_event"; watch: string; event: unknown }
  | { type: "event"; kind: "message"; row: FeedRow }
  | { type: "call"; id: string; op: RelayOp; args: ChatHttpArgs };

export type ServerFrame =
  | { type: "welcome"; protocol: number; feedAfter: number }
  | { type: "call"; id: string; op: ServerOp; args: Record<string, unknown> }
  | { type: "ack"; seq: number }
  | { type: "result"; id: string; ok: true; data: unknown }
  | { type: "result"; id: string; ok: false; error: string };

/** Parses one WebSocket text message into a frame, or undefined for anything that is not a JSON object with a string `type`. */
export function parseFrame<T extends { type: string }>(text: string): T | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string" ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}
