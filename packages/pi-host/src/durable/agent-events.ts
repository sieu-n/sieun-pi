/**
 * The agent events pi-host sends apps/chat for one conversation, built from the conversation's view watch.
 *
 * pi-durable 1.4 had `watchEvents()`; 1.5 removed it, and a client now renders the view (`Conversation.watch()`) instead.
 * apps/chat's server still reads events off the `durable_event` line (apps/chat/server/host/types.ts `AgentEvent`): it uses
 * `run_start`, `run_end`, `entry_appended` and `message_end` (an entry), and `tool_execution_start` and `tool_execution_end`.
 * This module derives those, plus a first `snapshot`, `auto_retry_start`/`auto_retry_end` and `deferred_poll`, from
 * consecutive view values, so the line keeps its shape across the upgrade and a Mac or metal apps/chat of either version
 * reads it. `message_update` says the in-flight answer grew and carries its usage, not its text: apps/chat shows no
 * streaming, and the whole partial on every update would grow the line with the square of the answer's length.
 */
import type { Context } from "@earendil-works/chord/context";
import type { WatchCall } from "@earendil-works/chord/watch";
import type { Conversation, ConversationView, EntryId, EntryRecord, JsonObject, LiveState, SubmissionId, ToolSlot } from "@earendil-works/pi-durable";

type Live = LiveState;

export type AgentEvent =
  | {
      type: "snapshot";
      entries: readonly EntryRecord[];
      run?: { inputs: readonly SubmissionId[] };
      generation?: Live["generation"];
      tools: readonly ToolSlot[];
      nestedTools: NonNullable<Live["nestedTools"]>;
      compactions: NonNullable<Live["compactions"]>;
      compactionFailure?: Live["compactionFailure"];
      inbox: readonly { id: SubmissionId; mode: string }[];
      agent: JsonObject;
      usage: JsonObject;
    }
  | { type: "run_start"; inputs: readonly SubmissionId[] }
  | { type: "run_end"; inputs: readonly SubmissionId[] }
  | { type: "entry_appended"; entry: EntryRecord }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: JsonObject }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: EntryRecord }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "auto_retry_end"; attempt: number }
  | { type: "message_update"; usage?: unknown; changes: readonly never[] }
  | { type: "deferred_poll"; pollAt: number };

export interface AgentEventStream {
  /** The conversation as the watch began, with its window of entries. */
  readonly snapshot: Extract<AgentEvent, { type: "snapshot" }>;
  /** Starts the deliveries: each call gets the events of the commits made since the last one, in order. */
  start(listener: (events: AgentEvent[], context: Context) => Promise<void> | void): void;
  stop(): Promise<void>;
}

const PAGE = 200;

const liveOf = (view: ConversationView): Live => (view.docs["pi.live"] ?? {}) as Live;

function snapshotOf(view: ConversationView): Extract<AgentEvent, { type: "snapshot" }> {
  const live = liveOf(view);
  const inbox = (view.docs["pi.inbox"] as { items?: { id: SubmissionId; mode: string }[] } | undefined)?.items ?? [];
  return {
    type: "snapshot",
    entries: view.entries,
    ...(live.run === undefined ? {} : { run: { inputs: live.run.inputs } }),
    ...(live.generation === undefined ? {} : { generation: live.generation }),
    tools: live.tools ?? [],
    nestedTools: live.nestedTools ?? [],
    compactions: live.compactions ?? [],
    ...(live.compactionFailure === undefined ? {} : { compactionFailure: live.compactionFailure }),
    inbox: inbox.map(item => ({ id: item.id, mode: item.mode })),
    agent: view.docs["pi.agent"] ?? {},
    usage: view.docs["pi.usage"] ?? {},
  };
}

/** The arguments of the model's call `callId`, from the newest assistant entry that made it. */
function argsOf(entries: readonly EntryRecord[], callId: string): JsonObject {
  for (let i = entries.length - 1; i >= 0; i--) {
    for (const message of entries[i]!.model ?? []) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) if (block.type === "toolCall" && block.id === callId) return block.arguments as JsonObject;
    }
  }
  return {};
}

const sameInputs = (a: readonly SubmissionId[], b: readonly SubmissionId[]): boolean => a.some(id => b.includes(id));

/**
 * The events between two values of one conversation's view. `appended` are the entries after the last one sent, in id
 * order, read from the window or, when the window dropped some, from the transcript.
 */
export function eventsBetween(before: ConversationView, after: ConversationView, appended: readonly EntryRecord[]): AgentEvent[] {
  const was = liveOf(before);
  const now = liveOf(after);
  const events: AgentEvent[] = [];
  // A run that ended and another that started between two values: inputs tell them apart, as a run keeps its inputs to its end.
  const restarted = was.run !== undefined && now.run !== undefined && was.run.inputs.length > 0 && now.run.inputs.length > 0 && !sameInputs(was.run.inputs, now.run.inputs);
  const ended = was.run !== undefined && (now.run === undefined || restarted);
  const started = now.run !== undefined && (was.run === undefined || restarted);
  if (restarted) events.push({ type: "run_end", inputs: was.run!.inputs });
  if (started) events.push({ type: "run_start", inputs: now.run!.inputs });

  const byId = new Map<EntryId, EntryRecord>([...after.entries, ...appended].map(entry => [entry.id, entry]));
  const slotsBefore = new Map((was.tools ?? []).map(slot => [slot.callId, slot]));
  const slots = now.tools ?? [];
  for (const slot of slots) {
    const prior = slotsBefore.get(slot.callId);
    if (slot.status !== "pending" && (prior === undefined || prior.status === "pending")) {
      events.push({ type: "tool_execution_start", toolCallId: slot.callId, toolName: slot.name, args: argsOf([...after.entries, ...appended], slot.callId) });
    }
  }
  const partial = now.generation?.message;
  if (partial !== undefined && partial !== was.generation?.message) events.push({ type: "message_update", usage: (partial as { usage?: unknown }).usage, changes: [] });
  for (const entry of appended) events.push({ type: "entry_appended", entry });
  for (const slot of slots) {
    const prior = slotsBefore.get(slot.callId);
    if (slot.status === "done" && prior?.status !== "done") {
      const entry = slot.entry === undefined ? undefined : byId.get(slot.entry);
      events.push({ type: "tool_execution_end", toolCallId: slot.callId, toolName: slot.name, ...(entry ? { entry } : {}) });
    }
  }
  // A slot that left the round before it was done: its run ended or its generation moved on.
  const current = new Set(slots.map(slot => slot.callId));
  for (const [callId, slot] of slotsBefore) {
    if (!current.has(callId) && slot.status !== "done") events.push({ type: "tool_execution_end", toolCallId: callId, toolName: slot.name });
  }

  const retryWas = was.generation?.retry;
  const retryNow = now.generation?.retry;
  if (retryNow !== undefined && (retryWas === undefined || retryWas.at !== retryNow.at)) {
    events.push({ type: "auto_retry_start", attempt: now.generation!.attempt, at: retryNow.at, errorMessage: retryNow.error });
  } else if (retryWas !== undefined && retryNow === undefined) {
    events.push({ type: "auto_retry_end", attempt: was.generation?.attempt ?? 0 });
  }
  const pollAt = now.generation?.deferred?.pollAt;
  if (pollAt !== undefined && pollAt !== was.generation?.deferred?.pollAt) events.push({ type: "deferred_poll", pollAt });
  if (ended && !restarted) events.push({ type: "run_end", inputs: was.run!.inputs });
  return events;
}

/** Attaches to one conversation's view and turns its changes into agent events. */
export async function watchEvents(conversation: Conversation, context: Context): Promise<AgentEventStream> {
  const watch = await conversation.watch(context);
  const first = watch.value;
  let last = first;
  let sent: EntryId | undefined = first.entries.at(-1)?.id ?? first.before;

  /** The entries after `sent`: from the window, plus the ones between `sent` and the window's start when it dropped some. */
  async function appendedIn(view: ConversationView, ctx: Context): Promise<EntryRecord[]> {
    const fresh = view.entries.filter(entry => sent === undefined || entry.id > sent);
    const gap = view.before !== undefined && (sent === undefined || view.before > sent);
    if (!gap) return fresh;
    const missed: EntryRecord[] = [];
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await conversation.entries({ order: "ascending", ...(sent === undefined ? {} : { minEntryId: (sent + 1) as EntryId }), maxEntryId: view.before }, PAGE, cursor, ctx);
      missed.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return [...missed, ...fresh];
  }

  return {
    snapshot: snapshotOf(first),
    start(listener) {
      watch.start(async (call: WatchCall<ConversationView>, ctx) => {
        if (call.kind !== "value") return;
        const appended = await appendedIn(call.value, ctx);
        const events = eventsBetween(last, call.value, appended);
        last = call.value;
        if (appended.length) sent = appended.at(-1)!.id;
        if (events.length) await listener(events, ctx);
      });
    },
    async stop() {
      await watch.stop();
    },
  };
}
