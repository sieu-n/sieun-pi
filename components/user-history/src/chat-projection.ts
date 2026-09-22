import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { parseSkillBlock, type DaemonAgentConnection, type SessionSummary } from "prime-agent";
import type { AssistantMessage, ChildAgent, ImagePart, ModelInfo, ProjectedSessionEvent, TextPart, ThinkingPart, ThreadInfo, ThreadMessage, ToolCallPart, ToolResultMessage } from "./shared/types.ts";

export const TEXT_LIMIT = 600;
export const THINKING_LIMIT = 240;
export const ARGUMENT_LIMIT = 400;
export const NOTE_LIMIT = 2048;
export const USER_TEXT_LIMIT = 24000;
export const IMAGE_STORE_BYTES = 96 * 1024 * 1024;

type NativeState = Awaited<ReturnType<DaemonAgentConnection["getState"]>>;
type NativeChild = Awaited<ReturnType<DaemonAgentConnection["getRlmChildSnapshots"]>>[number];
type NativeSessionEvent = Extract<Parameters<Parameters<DaemonAgentConnection["subscribe"]>[0]>[0], { type: "session_event" }>["event"];
type NativeModel = NonNullable<NativeState["model"]>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class ImageStore {
  private readonly entries = new Map<string, { mimeType: string; bytes: Buffer }>();
  private size = 0;
  constructor(private readonly limit = IMAGE_STORE_BYTES) {}
  put(mimeType: string, data: string): string {
    const hash = createHash("sha256").update(mimeType).update("\0").update(data).digest("hex");
    const existing = this.entries.get(hash);
    if (existing) { this.entries.delete(hash); this.entries.set(hash, existing); return hash; }
    const bytes = Buffer.from(data, "base64");
    this.entries.set(hash, { mimeType, bytes });
    this.size += bytes.length;
    while (this.size > this.limit && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value!;
      this.size -= this.entries.get(oldest)!.bytes.length;
      this.entries.delete(oldest);
    }
    return hash;
  }
  get(hash: string): { mimeType: string; bytes: Buffer } | undefined {
    const entry = this.entries.get(hash);
    if (entry) { this.entries.delete(hash); this.entries.set(hash, entry); }
    return entry;
  }
}

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}
function textPart(text: string, limit: number): TextPart {
  const clipped = clip(text, limit);
  return clipped.truncated ? { type: "text", text: clipped.text, truncated: true } : { type: "text", text: clipped.text };
}

export class Projector {
  constructor(readonly images: ImageStore) {}

  private image(part: { mimeType: string; data: string }): ImagePart {
    return { type: "image", mimeType: part.mimeType, url: "api/images/" + this.images.put(part.mimeType, part.data) };
  }
  /** A skill invocation is stored expanded; show what the user typed plus the skill name, like the TUI. */
  private user(content: unknown, timestamp: number): ThreadMessage {
    const raw = typeof content === "string" ? content : Array.isArray(content)
      ? content.flatMap((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
    const skill = raw.trimStart().startsWith("<skill") ? parseSkillBlock(raw) : null;
    const projected = this.userContent(content, USER_TEXT_LIMIT);
    if (!skill) return { role: "user", content: projected, timestamp };
    const images = typeof projected === "string" ? [] : projected.filter((part): part is ImagePart => part.type === "image");
    const typed = skill.userMessage?.trim() ?? "";
    return { role: "user", content: [...(typed ? [textPart(typed, USER_TEXT_LIMIT)] : []), ...images], timestamp, skill: skill.name };
  }
  private userContent(content: unknown, limit: number): string | (TextPart | ImagePart)[] {
    if (typeof content === "string") return clip(content, limit).text;
    if (!Array.isArray(content)) return "";
    return content.flatMap((part: unknown): (TextPart | ImagePart)[] => {
      if (!isRecord(part)) return [];
      if (part.type === "text" && typeof part.text === "string") return [textPart(part.text, limit)];
      if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") return [this.image({ mimeType: part.mimeType, data: part.data })];
      return [];
    });
  }
  private assistantContent(content: unknown): (TextPart | ThinkingPart | ToolCallPart)[] {
    if (!Array.isArray(content)) return [];
    return content.flatMap((part: unknown): (TextPart | ThinkingPart | ToolCallPart)[] => {
      if (!isRecord(part)) return [];
      if (part.type === "text" && typeof part.text === "string") return [textPart(part.text, USER_TEXT_LIMIT)];
      if (part.type === "thinking" && typeof part.thinking === "string") {
        const clipped = clip(part.thinking, THINKING_LIMIT);
        return [{ type: "thinking", thinking: clipped.text, ...(clipped.truncated ? { truncated: true } : {}), ...(part.redacted === true ? { redacted: true } : {}) }];
      }
      if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
        let truncated = false;
        const args: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(isRecord(part.arguments) ? part.arguments : {})) {
          if (typeof value === "string" && value.length > ARGUMENT_LIMIT) { args[key] = value.slice(0, ARGUMENT_LIMIT); truncated = true; }
          else if (JSON.stringify(value).length > ARGUMENT_LIMIT) { args[key] = JSON.stringify(value).slice(0, ARGUMENT_LIMIT); truncated = true; }
          else args[key] = value;
        }
        return [{ type: "toolCall", id: part.id, name: part.name, arguments: args, ...(truncated ? { truncated: true } : {}) }];
      }
      return [];
    });
  }
  assistant(message: AgentMessage & { role: "assistant" }): AssistantMessage {
    return { role: "assistant", content: this.assistantContent(message.content), provider: message.provider, model: message.model,
      stopReason: message.stopReason, ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}), timestamp: message.timestamp };
  }
  toolResult(message: AgentMessage & { role: "toolResult" }): ToolResultMessage {
    const content = this.userContent(message.content, TEXT_LIMIT);
    const durationMs = isRecord(message.details) && typeof message.details.durationMs === "number" ? message.details.durationMs : undefined;
    return { role: "toolResult", toolCallId: message.toolCallId, toolName: message.toolName, content: typeof content === "string" ? [textPart(content, TEXT_LIMIT)] : content,
      isError: message.isError, timestamp: message.timestamp, ...(durationMs === undefined ? {} : { durationMs }) };
  }
  message(message: AgentMessage): ThreadMessage | null {
    switch (message.role) {
      case "user": return this.user(message.content, message.timestamp);
      case "assistant": return this.assistant(message);
      case "toolResult": return this.toolResult(message);
      case "custom": return message.display ? { role: "custom", customType: message.customType, content: this.userContent(message.content, NOTE_LIMIT), timestamp: message.timestamp } : null;
      case "bashExecution": {
        const output = clip(message.output, TEXT_LIMIT);
        return { role: "bashExecution", command: message.command, output: output.text, ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
          cancelled: message.cancelled, truncated: message.truncated || output.truncated, timestamp: message.timestamp };
      }
      case "branchSummary": return { role: "branchSummary", summary: clip(message.summary, NOTE_LIMIT).text, timestamp: message.timestamp };
      case "compactionSummary": return { role: "compactionSummary", summary: clip(message.summary, NOTE_LIMIT).text, tokensBefore: message.tokensBefore, timestamp: message.timestamp };
      default: return null;
    }
  }
  messages(messages: readonly AgentMessage[]): ThreadMessage[] {
    return messages.flatMap(message => { const projected = this.message(message); return projected ? [projected] : []; });
  }
  private resultText(result: unknown): string {
    if (!isRecord(result) || !Array.isArray(result.content)) return "";
    return clip(result.content.flatMap((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n"), TEXT_LIMIT).text;
  }
  event(event: NativeSessionEvent): ProjectedSessionEvent | null {
    switch (event.type) {
      case "agent_start": case "agent_end": case "turn_start": case "turn_end": case "compaction_start": return { type: event.type };
      case "message_start": case "message_end": {
        const message = this.message(event.message);
        return message ? { type: event.type, message } : null;
      }
      case "message_update": return event.message.role === "assistant" ? { type: "message_update", message: this.assistant(event.message) } : null;
      case "tool_execution_start": return { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName };
      case "tool_execution_update": return { type: "tool_execution_update", toolCallId: event.toolCallId, toolName: event.toolName, partial: this.resultText(event.partialResult) };
      case "tool_execution_end": return { type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError };
      case "compaction_end": return { type: "compaction_end", aborted: event.aborted, ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}) };
      case "auto_retry_start": return { type: "auto_retry_start", attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage };
      case "auto_retry_end": return { type: "auto_retry_end", success: event.success, attempt: event.attempt, ...(event.finalError ? { finalError: event.finalError } : {}) };
      case "session_info_changed": return { type: "session_info_changed", name: event.name };
      case "thinking_level_changed": return { type: "thinking_level_changed", level: event.level };
      case "rlm_child_update": return { type: "rlm_child_update", child: projectChild(event.child) };
      case "session_action_update": return { type: "session_action_update", active: event.actions.active ? { label: event.actions.active.label ?? "Working" } : null, queuedCount: event.actions.queuedCount };
      case "recap_update": return { type: "recap_update", recap: event.recap };
      case "bash_start": return { type: "bash_start", command: event.command };
      case "bash_end": return { type: "bash_end", exitCode: event.exitCode, cancelled: event.cancelled };
      default: return null;
    }
  }
}

export function projectModel(model: NativeModel): ModelInfo {
  return { provider: model.provider, id: model.id, name: model.name, input: [...model.input], contextWindow: model.contextWindow, reasoning: model.reasoning };
}

export function projectChild(child: NativeChild): ChildAgent {
  return { id: child.id, label: child.label, status: child.status,
    ...(child.parentId === undefined ? {} : { parentId: child.parentId }), ...(child.sessionName === undefined ? {} : { sessionName: child.sessionName }),
    ...(child.model === undefined ? {} : { model: child.model }), ...(child.durationMs === undefined ? {} : { durationMs: child.durationMs }),
    ...(child.recap === undefined ? {} : { recap: child.recap }), ...(child.error === undefined ? {} : { error: child.error }),
    ...(child.answerPreview === undefined ? {} : { answerPreview: child.answerPreview }), ...(child.activity === undefined ? {} : { activity: child.activity }) };
}

export function sessionUsage(value: unknown): ThreadInfo["usage"] {
  if (!isRecord(value)) return null;
  const { inputTokens, outputTokens, cost } = value;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number" || typeof cost !== "number") return null;
  return { inputTokens, outputTokens, cost };
}

export function projectInfo(state: NativeState, summary: Pick<SessionSummary, "usage"> | undefined): ThreadInfo {
  return {
    sessionId: state.sessionId,
    ...(state.sessionName?.trim() ? { name: state.sessionName } : {}),
    cwd: state.cwd,
    model: state.model ? projectModel(state.model) : null,
    thinkingLevel: state.thinkingLevel,
    availableThinkingLevels: [...state.availableThinkingLevels],
    isStreaming: state.isStreaming,
    isCompacting: state.isCompacting,
    isBashRunning: state.isBashRunning,
    retryAttempt: state.retryAttempt,
    messageCount: state.messageCount,
    context: state.contextUsage && state.contextUsage.tokens !== null && state.contextUsage.percent !== null
      ? { tokens: state.contextUsage.tokens, contextWindow: state.contextUsage.contextWindow, percent: state.contextUsage.percent } : null,
    usage: sessionUsage(summary?.usage),
    sessionAction: state.sessionActions.active ? { label: state.sessionActions.active.label ?? "Working" } : null,
    queuedActions: state.sessionActions.queuedCount,
    ...(state.recap ? { recap: state.recap } : {}),
  };
}
