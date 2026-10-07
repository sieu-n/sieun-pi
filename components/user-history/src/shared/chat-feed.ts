import { isPromptCustom, messageText, triggerSummary } from "./turns.ts";
import type { AssistantMessage, CustomMessage, ImagePart, ThreadMessage, ThreadState, UserMessage } from "./types.ts";

/** A message the owner sent from the chat composer that the thread has not echoed back yet. `images` are data URLs for the bubble. */
export interface PendingSend { id: string; text: string; images: ImagePart[]; at: number }

/**
 * One flat line of a chat. The feed never nests: the chat partner talks like a DM, so every message is its own line in order.
 * - user: what the owner typed (right side); `pending` until the thread echoes the message back.
 * - agent: the chat partner's text (left side); `streaming` while the model is still writing it.
 * - job: a worker's agent_message, folded to one line ("from <name>: <first line>") that opens on tap; `clipped` names the message and part
 *   to fetch through `api/threads/:id/part` when the snapshot holds only the first 2 KiB of the body.
 * - notice: an error, a stopped reply, a restart or another event the owner should see, as one muted line.
 */
export type ChatItem =
  | { kind: "user"; id: string; text: string; images: ImagePart[]; at: number; pending?: true }
  | { kind: "agent"; id: string; text: string; at: number; streaming?: true }
  | { kind: "job"; id: string; from: string; title: string; body: string; at: number; clipped?: { message: number; part: number } }
  | { kind: "notice"; id: string; text: string; at: number };

/** A user message echoed by the daemon up to this long before the browser's send time still settles the pending send (clock skew between devices). */
export const PENDING_SKEW_MS = 5 * 60_000;

const imagesOf = (message: UserMessage | CustomMessage): ImagePart[] =>
  typeof message.content === "string" ? [] : message.content.filter((part): part is ImagePart => part.type === "image");

const firstLine = (text: string): string => text.split("\n").map(line => line.trim()).find(Boolean) ?? "";

function assistantItems(message: AssistantMessage, id: string, streaming: boolean): ChatItem[] {
  const items: ChatItem[] = [];
  const text = messageText(message).trim();
  if (text) items.push({ kind: "agent", id, text, at: message.timestamp, ...(streaming ? { streaming: true } : {}) });
  if (streaming) return items;
  if (message.stopReason === "aborted") items.push({ kind: "notice", id: id + "-stop", text: "Reply stopped", at: message.timestamp });
  else if (message.stopReason === "error") items.push({ kind: "notice", id: id + "-error", text: "Error: " + (message.errorMessage?.trim() || "the model returned an error"), at: message.timestamp });
  return items;
}

function customItems(message: CustomMessage, id: string, index: number): ChatItem[] {
  if (!isPromptCustom(message)) return [];
  const summary = triggerSummary(message);
  if (message.customType === "agent_message") {
    const from = summary.detail.replace(/^from\s+/, "") || "a worker";
    const part = typeof message.content === "string" ? -1 : message.content.findIndex(entry => entry.type === "text" && entry.truncated);
    return [{ kind: "job", id, from, title: firstLine(summary.body) || "(empty message)", body: summary.body, at: message.timestamp, ...(part >= 0 ? { clipped: { message: index, part } } : {}) }];
  }
  const text = [summary.label, summary.detail].filter(Boolean).join(", ");
  return [{ kind: "notice", id, text, at: message.timestamp }];
}

/**
 * Message role and custom type to chat lines:
 * user -> user; assistant text -> agent (plus a notice on error or abort; thinking and tool calls produce nothing);
 * custom agent_message -> job; other wake-up customs (heartbeat, background command, subagent exit, restart, goal) -> notice;
 * compactionSummary -> notice; toolResult, bashExecution, branchSummary and non-prompt customs -> nothing.
 */
export function chatItemsOf(message: ThreadMessage, index: number): ChatItem[] {
  const id = "m" + index;
  switch (message.role) {
    case "user": return [{ kind: "user", id, text: messageText(message).trim(), images: imagesOf(message), at: message.timestamp }];
    case "assistant": return assistantItems(message, id, false);
    case "custom": return customItems(message, id, index);
    case "compactionSummary": return [{ kind: "notice", id, text: "Older messages were summarized to free space", at: message.timestamp }];
    case "toolResult":
    case "bashExecution":
    case "branchSummary":
      return [];
  }
}

/** Ids of the pending sends a user message in `messages` has settled: same text, and not from before the send (minus clock skew). Each message settles at most one. */
export function settledPending(messages: readonly ThreadMessage[], pending: readonly PendingSend[]): Set<string> {
  const settled = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = messageText(message).trim();
    const match = pending.find(send => !settled.has(send.id) && send.text === text && message.timestamp >= send.at - PENDING_SKEW_MS);
    if (match) settled.add(match.id);
  }
  return settled;
}

/** The whole chat, oldest first: every message as lines, then the streaming reply, then the sends the thread has not echoed yet. */
export function chatFeed(state: Pick<ThreadState, "messages" | "streaming">, pending: readonly PendingSend[] = []): ChatItem[] {
  const items = state.messages.flatMap(chatItemsOf);
  if (state.streaming) items.push(...assistantItems(state.streaming, "streaming", true));
  const settled = settledPending(state.messages, pending);
  for (const send of pending) {
    if (settled.has(send.id)) continue;
    items.push({ kind: "user", id: "p" + send.id, text: send.text, images: send.images, at: send.at, pending: true });
  }
  return items;
}
