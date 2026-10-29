/**
 * The host's outbox of speaking calls that went out, and the `durable_feed` streams over it (apps/chat/docs/agent-model.md, section 4
 * point 2). Each `send_message` or `tell_owner` call in a thread's root conversation whose result is neither an error nor tell_owner's held
 * note gets one `outbox` row in index.sqlite when its result entry is indexed (index-db.ts `addEntries`). The row's requestId is
 * `m:<thread>:<toolCallId>`, which is unique, so a call pi-durable replays after a crash, or a thread whose index rows are read again, adds
 * no second row. The agent relay forwards the rows to the chat server as `event` frames (components/prime-relay/agents/protocol.ts).
 */
import { ROOT_CONVERSATION_ID, type EntryRecord } from "@earendil-works/pi-durable";
import type { FeedRow } from "../../../../components/prime-relay/agents/protocol.ts";
import { TELL_OWNER_HELD, TELL_OWNER_TOOL } from "../../../../legacy/prime/user-history/src/shared/chat-feed.ts";
import type { Sink } from "../session.ts";
import type { SpokenCall, ThreadIndex } from "./index-db.ts";
import { SEND_MESSAGE_TOOL } from "./send-message.ts";

export type { FeedRow };

/** The tools whose calls are messages to people; prime-chat.ts `SPEAKING_TOOLS` without its imports. */
const SPEAKING = new Set([TELL_OWNER_TOOL, SEND_MESSAGE_TOOL]);

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.flatMap(c => (c?.type === "text" && typeof c.text === "string" ? [c.text as string] : [])).join("\n") : "";

const trimmed = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/**
 * What one root entry adds to the outbox: the speaking calls of an assistant entry, or the outcome of a speaking call's result. A call
 * with no text is not a message, as apps/chat timeline.ts `sentMessage` reads it.
 */
export function speechOf(entry: EntryRecord): { calls?: SpokenCall[]; result?: { toolCallId: string; sent: boolean } } {
  if (entry.conversationId !== ROOT_CONVERSATION_ID) return {};
  const message = entry.model?.[0] as { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean } | undefined;
  if (message?.role === "assistant" && Array.isArray(message.content)) {
    const calls = (message.content as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]).flatMap(block => {
      if (block.type !== "toolCall" || !block.id || !SPEAKING.has(block.name ?? "")) return [];
      const text = trimmed(block.arguments?.text);
      if (!text) return [];
      const to = trimmed(block.arguments?.to);
      const why = trimmed(block.arguments?.why);
      return [{ toolCallId: block.id, toolName: block.name!, text, ...(to ? { to } : {}), ...(why ? { why } : {}) }];
    });
    return calls.length ? { calls } : {};
  }
  if (message?.role === "toolResult" && message.toolCallId && SPEAKING.has(message.toolName ?? "")) {
    const held = message.toolName === TELL_OWNER_TOOL && textOf(message.content).startsWith(TELL_OWNER_HELD);
    return { result: { toolCallId: message.toolCallId, sent: !message.isError && !held } };
  }
  return {};
}

/** The rows of one backlog read; the feed reads its backlog in pages of this size, which only bounds one statement's result. */
const PAGE = 500;

/** The `durable_feed` streams of each connection: the backlog after a cursor, then each new row, until a stop or disconnect. */
export class FeedStreams {
  private readonly feeds = new Map<string, Map<string, () => void>>();

  constructor(private readonly index: ThreadIndex) {}

  /**
   * Writes every row after `after` to the sink, then each new row as it is added. The backlog read and the subscription happen in one
   * synchronous step, and index writes are synchronous too, so no row falls between them and none is written twice.
   */
  open(sink: Sink, feed: string, after: number): void {
    let last = after;
    const write = (row: FeedRow) => {
      if (row.seq <= last) return;
      last = row.seq;
      sink.write({ type: "durable_feed_event", feed, row });
    };
    for (;;) {
      const page = this.index.readOutbox(last, PAGE);
      for (const row of page.rows) write(row);
      if (!page.more) break;
    }
    const stop = this.index.onOutbox(write);
    let mine = this.feeds.get(sink.clientId);
    if (!mine) this.feeds.set(sink.clientId, (mine = new Map()));
    mine.set(feed, stop);
  }

  stop(clientId: string, feed: string): boolean {
    const stop = this.feeds.get(clientId)?.get(feed);
    this.feeds.get(clientId)?.delete(feed);
    stop?.();
    return stop !== undefined;
  }

  disconnect(clientId: string): void {
    const mine = this.feeds.get(clientId);
    this.feeds.delete(clientId);
    for (const stop of mine?.values() ?? []) stop();
  }
}
