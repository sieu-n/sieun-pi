import type { AssistantMessage, BashExecutionMessage, BranchSummaryMessage, CompactionSummaryMessage, CustomMessage, ThinkingPart, ThreadMessage, ToolCallPart, ToolResultMessage, ToolRun, UserMessage } from "./types.ts";

export type SystemMessage = BashExecutionMessage | BranchSummaryMessage | CompactionSummaryMessage | CustomMessage;
/** Everything in a turn except its prompt, trigger and final reply. The Default view folds all of it into one row. */
export type WorkItem =
  | { kind: "thinking"; part: ThinkingPart; messageIndex: number; partIndex: number }
  | { kind: "tool"; call: ToolCallPart; result: ToolResultMessage | null; run: ToolRun | null; messageIndex: number; partIndex: number }
  | { kind: "note"; text: string; messageIndex: number }
  | { kind: "system"; message: SystemMessage; messageIndex: number }
  | { kind: "trigger"; message: CustomMessage; messageIndex: number }
  /** An agent message or background completion that arrived after the run settled, with the run it started. */
  | { kind: "exchange"; turn: Turn; messageIndex: number };
/**
 * A user prompt, or a heartbeat, opens a turn. Agent messages and background completions that arrive after the turn's run
 * settles nest inside it as exchanges, each a turn of its own with a trigger, work and reply. The turn's Response is the
 * latest reply among its own run and its exchanges; every other reply stays in the work as a note.
 */
export interface Turn {
  key: string;
  /** What the user typed. */
  prompt: { message: UserMessage; index: number } | null;
  /** A native custom message that started work (agent message, heartbeat, background command); never shown as a user prompt. */
  trigger: { message: CustomMessage; index: number } | null;
  work: WorkItem[];
  reply: { message: AssistantMessage; index: number; live: boolean } | null;
  startedAt: number;
  endedAt: number;
  live: boolean;
}

export function messageText(message: { content: string | { type: string; text?: string }[] }): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n\n");
}

export function isPromptCustom(message: CustomMessage): boolean {
  return message.customType === "agent_message" || message.customType === "heartbeat_prompt" || message.customType === "async_bash_completion";
}

/** A heartbeat is a scheduled prompt and opens its own turn. Other triggers nest in the turn they answer. */
const opensTurn = (message: CustomMessage): boolean => message.customType === "heartbeat_prompt";

type Exchange = Extract<WorkItem, { kind: "exchange" }>;
const lastExchange = (turn: Turn): Exchange | undefined => turn.work.findLast((item): item is Exchange => item.kind === "exchange");

/** The run new messages belong to: the latest exchange, else the turn itself. */
export function currentRun(turn: Turn): Turn {
  return lastExchange(turn)?.turn ?? turn;
}

/** The reply shown under the turn: the latest reply among its exchanges, else its own. */
export function responseOf(turn: Turn): Turn["reply"] {
  for (let index = turn.work.length - 1; index >= 0; index--) {
    const item = turn.work[index]!;
    if (item.kind === "exchange" && item.turn.reply) return item.turn.reply;
  }
  return turn.reply;
}

/** A run's items as the work list shows them: its reply becomes a note in place, before any exchange, unless it is the Response. */
export function workItems(turn: Turn, response: Turn["reply"]): WorkItem[] {
  const reply = turn.reply;
  const text = reply && reply !== response ? messageText(reply.message).trim() : "";
  if (!reply || !text) return turn.work;
  const note: WorkItem = { kind: "note", text, messageIndex: reply.index };
  const at = turn.work.findIndex(item => item.kind === "exchange");
  return at < 0 ? [...turn.work, note] : [...turn.work.slice(0, at), note, ...turn.work.slice(at)];
}

/** One-line label and body for a trigger, from the native "[kind detail]" header line. */
export function triggerSummary(message: CustomMessage): { label: string; detail: string; body: string } {
  const text = messageText(message).trim();
  const match = /^\[([^\]\n]+)\]\s*/.exec(text);
  const header = match?.[1] ?? "";
  const body = (match ? text.slice(match[0].length) : text).trim();
  if (message.customType === "agent_message") {
    const from = /^agent-message from\s+(.+)$/i.exec(header)?.[1] ?? "";
    return { label: "Message", detail: from ? "from " + from : "", body };
  }
  if (message.customType === "async_bash_completion") {
    const exit = /exit:(\S+)/.exec(header)?.[1];
    const command = /^Command:\s*"?([\s\S]*?)"?\s*$/.exec(body)?.[1] ?? body;
    return { label: "Background command finished", detail: exit !== undefined ? "exit " + exit : "", body: command };
  }
  if (message.customType === "heartbeat_prompt") return { label: "Heartbeat", detail: header, body };
  return { label: message.customType.replaceAll("_", " "), detail: header, body };
}

export function toolDurationMs(item: Extract<WorkItem, { kind: "tool" }>, now: number): number | null {
  if (item.result?.durationMs !== undefined) return item.result.durationMs;
  if (item.run) return Math.max(0, now - item.run.startedAt);
  return null;
}

function addAssistant(turn: Turn, message: AssistantMessage, index: number, results: ReadonlyMap<string, ToolResultMessage>, live: boolean): void {
  const previousReply = turn.reply;
  if (previousReply && !previousReply.live) {
    const previousText = messageText(previousReply.message).trim();
    if (previousText) turn.work.push({ kind: "note", text: previousText, messageIndex: previousReply.index });
    turn.reply = null;
  }
  const failed = message.stopReason === "error" || message.stopReason === "aborted";
  const textIsNote = message.stopReason === "toolUse" && !failed && !live;
  message.content.forEach((part, partIndex) => {
    if (part.type === "thinking") { if (part.thinking.trim()) turn.work.push({ kind: "thinking", part, messageIndex: index, partIndex }); }
    else if (part.type === "toolCall") turn.work.push({ kind: "tool", call: part, result: results.get(part.id) ?? null, run: null, messageIndex: index, partIndex });
    else if (textIsNote && part.text.trim()) turn.work.push({ kind: "note", text: part.text.trim(), messageIndex: index });
  });
  const text = messageText(message).trim();
  if (!textIsNote && (text || failed || live)) turn.reply = { message, index, live };
  turn.endedAt = Math.max(turn.endedAt, message.timestamp);
}

function openTurn(index: number, timestamp: number): Turn {
  return { key: "turn-" + index, prompt: null, trigger: null, work: [], reply: null, startedAt: timestamp, endedAt: timestamp, live: false };
}

export function toolResults(messages: readonly ThreadMessage[]): Map<string, ToolResultMessage> {
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
  return results;
}

/**
 * Committed turns only. Recompute when `messages` changes; overlay the live tail with `liveTurn`.
 * A user message or heartbeat always starts a turn. An agent message or background completion that lands after the run
 * settled opens an exchange inside the current turn; one that lands mid-run is part of that run's work.
 */
export function buildTurns(messages: readonly ThreadMessage[]): Turn[] {
  const results = toolResults(messages);
  const turns: Turn[] = [];
  let current: Turn | undefined;
  let run: Turn | undefined;
  let settled = true;
  messages.forEach((message, index) => {
    const trigger = message.role === "custom" && isPromptCustom(message);
    if (message.role === "user" || (trigger && settled && (!current || opensTurn(message)))) {
      current = run = openTurn(index, message.timestamp);
      if (message.role === "user") current.prompt = { message, index };
      else if (message.role === "custom") current.trigger = { message, index };
      turns.push(current);
      settled = false;
      return;
    }
    if (trigger && settled && current) {
      run = openTurn(index, message.timestamp);
      run.trigger = { message, index };
      current.work.push({ kind: "exchange", turn: run, messageIndex: index });
      settled = false;
      return;
    }
    if (!current || !run) { current = run = openTurn(index, message.timestamp); turns.push(current); }
    if (message.role === "assistant") { addAssistant(run, message, index, results, false); settled = message.stopReason !== "toolUse"; }
    else if (message.role === "toolResult") run.endedAt = Math.max(run.endedAt, message.timestamp);
    else if (message.role === "custom" && trigger) run.work.push({ kind: "trigger", message, messageIndex: index });
    else run.work.push({ kind: "system", message, messageIndex: index });
  });
  return turns;
}

function withRuns(turn: Turn, tools: readonly ToolRun[]): Turn {
  return { ...turn, work: turn.work.map(item => item.kind === "tool" ? { ...item, run: tools.find(run => run.toolCallId === item.call.id) ?? null }
    : item.kind === "exchange" ? { ...item, turn: withRuns(item.turn, tools) } : item) };
}

/** The last turn with the streaming message and running tools folded in. `running` keeps it live between model calls. Returns null when nothing is live. */
export function liveTurn(last: Turn | undefined, streaming: AssistantMessage | null, tools: readonly ToolRun[], messageCount: number, running = false): Turn | null {
  const toolRunning = tools.some(run => run.status === "running");
  if (!streaming && !toolRunning && !running) return null;
  const turn: Turn = { ...withRuns(last ?? openTurn(messageCount, streaming?.timestamp ?? Date.now()), tools), live: true };
  const exchange = lastExchange(turn);
  if (exchange) {
    const liveExchange: Exchange = { ...exchange, turn: { ...exchange.turn, live: true } };
    turn.work = turn.work.map(item => item === exchange ? liveExchange : item);
  }
  if (streaming) addAssistant(currentRun(turn), streaming, messageCount, new Map(), true);
  return turn;
}

/** Counts for the folded row: tool calls, notes (interim messages, system notes, messages that arrived mid-run), and exchanges. */
export function workCounts(work: readonly WorkItem[]): { tools: number; notes: number; exchanges: number } {
  let tools = 0;
  let notes = 0;
  let exchanges = 0;
  for (const item of work) {
    if (item.kind === "tool") tools++;
    else if (item.kind === "exchange") exchanges++;
    else if (item.kind !== "thinking") notes++;
  }
  return { tools, notes, exchanges };
}

export function allTurns(messages: readonly ThreadMessage[], streaming: AssistantMessage | null = null, tools: readonly ToolRun[] = [], running = false): Turn[] {
  const turns = buildTurns(messages);
  const live = liveTurn(turns.at(-1), streaming, tools, messages.length, running);
  if (!live) return turns;
  return turns.length && turns.at(-1)!.key === live.key ? [...turns.slice(0, -1), live] : [...turns, live];
}
