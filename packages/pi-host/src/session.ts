/**
 * One session the host holds: its runtime, its event sequence and replay buffer, and the clients attached to it.
 *
 * Every event the runtime emits becomes one v7 `session_event` line with a cursor `{ generation, sequence }`. The generation changes each time
 * the host opens the session, so a client holding a cursor from before an unload or a host restart resyncs from a snapshot. The last
 * `replayLimit` lines stay in a ring buffer, which an attach with a cursor in range replays instead of a snapshot.
 */

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import * as registry from "../../pi-family/registry.ts";
import type { Identity } from "../../pi-family/registry.ts";
import {
  PROTOCOL, type ChildSnapshot, type ConnectionState, type EventCursor, type EventMeta, type ModelRef, type Outbound, type SessionActions,
  type SessionSnapshot, type SessionSummary,
} from "./protocol.ts";
import type { Job } from "./schedule.ts";

/** A client attached to the session; the server's connection implements it. */
export interface Sink {
  readonly clientId: string;
  write(line: Outbound): void;
}

type SessionEventLine = Extract<Outbound, { type: "session_event" }>;

/** Events the chat does not read and that would double the bytes on the wire: each entry also arrives as its message event. */
const DROPPED_EVENTS = new Set(["entry_appended"]);

export function modelRef(model: { provider: string; id: string } | undefined): ModelRef | undefined {
  if (!model) return undefined;
  const { provider, id, name, api, contextWindow, maxTokens, reasoning } = model as ModelRef;
  return { provider, id, name, api, contextWindow, maxTokens, reasoning };
}

function textOf(message: AgentMessage | undefined): string {
  if (!message || !("content" in message)) return "";
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? (part as { text: string }).text : "")).join("");
}

export class HostedSession {
  readonly id: string;
  readonly generation: string;
  readonly sinks = new Map<string, Sink>();
  readonly openedAt = Date.now();
  sequence = 0;
  lastActivityAt = Date.now();
  streamingMessage: AgentMessage | undefined;
  runningTools = 0;
  /** The session's user heartbeat, which the host's scheduler supplies. */
  heartbeat: () => Job | undefined = () => undefined;
  private readonly buffer: SessionEventLine[] = [];
  private unsubscribe: (() => void) | undefined;
  private firstMessage: string | undefined;

  constructor(
    readonly runtime: AgentSessionRuntime,
    readonly realPath: string | undefined,
    readonly identity: Identity,
    private readonly replayLimit: number,
    private readonly onLine: (session: HostedSession, line: SessionEventLine) => void,
  ) {
    this.id = runtime.session.sessionId;
    this.generation = `${this.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    this.subscribe();
    runtime.setRebindSession(async () => this.subscribe());
  }

  get session() {
    return this.runtime.session;
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.runtime.session.subscribe(event => this.onEvent(event as unknown as { type: string; [key: string]: unknown }));
  }

  private onEvent(event: { type: string; [key: string]: unknown }): void {
    this.lastActivityAt = Date.now();
    if (event.type === "message_start" || event.type === "message_update") {
      const message = event.message as AgentMessage | undefined;
      if (message && (message as { role?: string }).role === "assistant") this.streamingMessage = message;
    } else if (event.type === "message_end" || event.type === "agent_end") {
      this.streamingMessage = undefined;
    } else if (event.type === "tool_execution_start") {
      this.runningTools++;
    } else if (event.type === "tool_execution_end") {
      this.runningTools = Math.max(0, this.runningTools - 1);
    }
    if (event.type === "agent_end") this.runningTools = 0;
    if (DROPPED_EVENTS.has(event.type)) return;
    this.emit(event);
  }

  /** Adds one event to the sequence, the replay buffer and every attached client. The host also uses it for its own notices. */
  emit(event: { type: string; [key: string]: unknown }): SessionEventLine {
    this.sequence++;
    const line: SessionEventLine = { type: "session_event", activeSessionId: this.id, event, meta: this.meta(this.sequence) };
    this.buffer.push(line);
    if (this.buffer.length > this.replayLimit) this.buffer.splice(0, this.buffer.length - this.replayLimit);
    for (const sink of this.sinks.values()) sink.write(line);
    this.onLine(this, line);
    return line;
  }

  meta(sequence: number): EventMeta {
    return { id: `${this.id}:${sequence}`, protocol: PROTOCOL, activeSessionId: this.id, sequence, cursor: this.cursor(sequence), emittedAt: new Date().toISOString() };
  }

  cursor(sequence = this.sequence): EventCursor {
    return { generation: this.generation, sequence };
  }

  /** The buffered lines after `sequence`, or undefined when the buffer no longer reaches back that far. */
  replayAfter(sequence: number): SessionEventLine[] | undefined {
    if (sequence > this.sequence) return undefined;
    if (sequence === this.sequence) return [];
    const first = this.buffer[0]?.meta.sequence;
    if (first === undefined || first > sequence + 1) return undefined;
    return this.buffer.filter(line => line.meta.sequence > sequence).map(line => ({ ...line, meta: { ...line.meta, replayed: true } }));
  }

  get busy(): boolean {
    const s = this.session;
    return s.isStreaming || s.isCompacting || s.isBashRunning;
  }

  actions(): SessionActions {
    const steering = [...this.session.getSteeringMessages()];
    const followUps = [...this.session.getFollowUpMessages()];
    return { queuedCount: steering.length + followUps.length, steering, followUps };
  }

  private firstUserText(): string {
    if (this.firstMessage === undefined) {
      const first = this.session.messages.find(message => (message as { role?: string }).role === "user");
      if (first) this.firstMessage = textOf(first).slice(0, 500);
    }
    return this.firstMessage ?? "";
  }

  children(): ChildSnapshot[] {
    const out: ChildSnapshot[] = [];
    const walk = (parentId: string) => {
      for (const child of registry.childrenOf(parentId)) {
        const activity = child.activity();
        out.push({
          id: child.id, parentId, activeSessionId: child.id, sessionName: child.name, label: child.name,
          status: activity === "working" ? "running" : activity === "ended" ? "completed" : "idle", sessionDir: child.cwd,
        });
        walk(child.id);
      }
    };
    walk(this.id);
    return out;
  }

  summary(): SessionSummary {
    const s = this.session;
    const sm = s.sessionManager;
    const actions = this.actions();
    const activity = s.isCompacting ? "compacting" : s.isBashRunning ? "bash" : this.runningTools > 0 ? "tool" : s.isStreaming ? "model" : "idle";
    const busy = this.busy;
    const children = registry.childrenOf(this.id);
    return {
      id: this.id,
      activeSessionId: this.id,
      sessionId: this.id,
      sessionFile: s.sessionFile,
      sessionName: s.sessionName,
      cwd: sm.getCwd(),
      lifecycle: "resident",
      activity,
      isSessionActive: busy,
      runtimeKind: this.identity.role === "child" ? "subagent" : "top-level",
      rlmDepth: this.identity.depth,
      model: modelRef(s.model),
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
      isCompacting: s.isCompacting,
      isBashRunning: s.isBashRunning,
      isRunningTools: this.runningTools > 0,
      hasRunningRlmChildren: children.some(child => child.activity() === "working"),
      attachedClients: this.sinks.size,
      messageCount: s.messages.length,
      unfinishedActionCount: actions.queuedCount,
      sessionActions: actions,
      ...(this.streamingMessage ? { streamingMessage: this.streamingMessage } : {}),
      created: sm.getHeader()?.timestamp,
      modified: new Date(this.lastActivityAt).toISOString(),
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      firstMessage: this.firstUserText(),
      ...(this.identity.parentId ? { parentActiveSessionId: this.identity.parentId, parentSessionId: this.identity.parentId, rlmChildId: this.id } : {}),
      ...(sm.getHeader()?.parentSession ? { parentSessionPath: sm.getHeader()!.parentSession } : {}),
      rosterStatus: busy ? "running" : "idle",
      workerState: "ready",
      workerPid: process.pid,
      ...(this.runtime.diagnostics.length ? { diagnostics: [...this.runtime.diagnostics] } : {}),
    };
  }

  state(): ConnectionState {
    const s = this.session;
    const sm = s.sessionManager;
    return {
      activeSessionId: this.id,
      cwd: sm.getCwd(),
      model: modelRef(s.model),
      thinkingLevel: s.thinkingLevel,
      serviceTier: "auto",
      availableThinkingLevels: s.getAvailableThinkingLevels(),
      isStreaming: s.isStreaming,
      isCompacting: s.isCompacting,
      isBashRunning: s.isBashRunning,
      retryAttempt: s.retryAttempt,
      steeringMode: s.steeringMode,
      followUpMode: s.followUpMode,
      sessionFile: s.sessionFile,
      sessionId: this.id,
      sessionName: s.sessionName,
      sessionDir: sm.getSessionDir(),
      leafId: sm.getLeafId(),
      autoCompactionEnabled: s.autoCompactionEnabled,
      messageCount: s.messages.length,
      sessionActions: this.actions(),
      compactionCount: sm.getEntries().filter(entry => entry.type === "compaction").length,
      goal: { status: "none" },
      heartbeat: this.heartbeat() ?? null,
      scopedModels: [],
      activeToolNames: s.getActiveToolNames(),
      contextUsage: s.getContextUsage(),
    };
  }

  snapshot(): SessionSnapshot {
    return {
      activeSessionId: this.id, summary: this.summary(), state: this.state(), messages: [...this.session.messages],
      lastEventSequence: this.sequence, lastEventCursor: this.cursor(), children: this.children(),
    };
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.sinks.clear();
    await this.runtime.dispose();
  }
}
