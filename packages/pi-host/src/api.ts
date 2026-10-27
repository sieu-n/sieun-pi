/**
 * The in-process pi-host API, published on `globalThis` so code loaded into the host's sessions reaches it without importing pi-host.
 *
 * pi-agent-bus calls `deliver` to reach a root or a closed session in the same host, and build step 6 adds its scheduler on `deliver` and
 * `restore`. A plain `pi` CLI has no host, so `hostApi()` returns undefined there and the caller falls back to the socket in `PI_HOST_SOCKET`
 * (a `send_message` command, see `protocol.ts`) or fails with a message that says it needs pi-host.
 *
 * Session ids are Pi session ids. pi-host uses the session id as the v7 `activeSessionId` too, so one id names a session on the socket, in
 * this API and in `pi-family/registry.ts`.
 */

import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { BusMessage, Delivery, Identity } from "@sieun-pi/pi-family/registry";
import type { Scheduler } from "./scheduler.ts";

export interface OpenRequest {
  /** Reopen this session file. Without it the host creates a new session in `cwd`. */
  sessionPath?: string;
  cwd?: string;
  name?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  extensionFlagValues?: Record<string, boolean | string>;
  /** Written to `pi-family/registry.ts` before the session opens, so its extensions read it at `session_start`. Defaults to a root at depth 0. */
  identity?: Identity;
}

export interface HostSessionInfo {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  name?: string;
  loaded: true;
  streaming: boolean;
  attachedClients: number;
  lastActivityAt: number;
}

export type HostEvent =
  | { type: "opened"; sessionId: string }
  /** Sent before the host disposes a session, so an extension can detach work that should outlive the host (pi-rlm's kernel on "shutdown"). */
  | { type: "closing"; sessionId: string; reason: "killed" | "idle_unload" | "shutdown" }
  | { type: "closed"; sessionId: string; reason: "killed" | "idle_unload" | "shutdown" }
  | { type: "session_event"; sessionId: string; event: { type: string; [key: string]: unknown } };

export interface HostApi {
  readonly pid: number;
  readonly agentDir: string;
  readonly socketPath?: string;
  /** Loaded sessions only. A closed session is still reachable through `restore` and `deliver`. */
  list(): HostSessionInfo[];
  open(request: OpenRequest): Promise<HostSessionInfo>;
  /** The loaded runtime for a session id, or the runtime the host reopens from the session's file. Throws when no file is known. */
  restore(sessionIdOrPath: string): Promise<AgentSessionRuntime>;
  runtime(sessionId: string): AgentSessionRuntime | undefined;
  /**
   * Delivers `message` to `targetId`. A target that `pi-family/registry.ts` lists gets its own `deliver`, so pi-agent-bus decides the format and
   * lane. Otherwise the host restores the session if needed and delivers itself: an idle session gets `prompt`, a busy one gets `steer` for
   * `auto` and `steer`, or `followUp` for `follow_up`.
   */
  deliver(targetId: string, message: BusMessage): Promise<Delivery>;
  /** Disposes the runtime and releases its lease. The session file stays, so `restore` reopens it. */
  kill(sessionId: string): Promise<void>;
  /** The session file for an id the host has seen or can find under its session dirs. */
  sessionPath(sessionId: string): Promise<string | undefined>;
  onEvent(listener: (event: HostEvent) => void): () => void;
  /** Heartbeats, RLM heartbeats and cron prompts that fire into loaded and unloaded sessions (`scheduler.ts`). */
  readonly scheduler?: Scheduler;
}

const KEY = Symbol.for("sieun-pi.pi-stack.host");

export function hostApi(): HostApi | undefined {
  return (globalThis as unknown as Record<symbol, HostApi | undefined>)[KEY];
}

export function publishHostApi(api: HostApi | undefined): void {
  const g = globalThis as unknown as Record<symbol, HostApi | undefined>;
  if (api) g[KEY] = api;
  else delete g[KEY];
}

/** The env var a plain `pi` CLI or a child process reads to reach pi-host's socket. */
export const HOST_SOCKET_ENV = "PI_HOST_SOCKET";
