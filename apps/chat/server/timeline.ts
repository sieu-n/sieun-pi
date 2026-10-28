/**
 * pi-durable entries to timeline items. A thread's page reads its entries oldest first: each input (the owner's text, another agent's
 * message) is a `message` item, every assistant and tool-result entry after it joins one `turn` item, and a compaction is a `system` item.
 * The same function builds a stored page and the live turn, so both read alike.
 */
import type { ImageRef, Item, JobRef, Principal, RunStatus, Step } from "../web/src/lib/api/types.ts";
import type { ContentBlock, EntryRecord, Message, TreeNode } from "./host/types.ts";

export const INPUT_KINDS = new Set(["pi.user", "agent.message", "prime.custom"]);
export const TURN_KINDS = new Set(["pi.assistant", "pi.tool-result"]);

export interface TimelineContext {
  thread: string;
  conversation: number;
  /** The agent that owns this conversation. */
  agent: Principal;
  /** Resolves an `agent.message` sender, which is "owner", an agent id or a free name. */
  principal(from: string): Principal;
  /** Child conversations of the thread, for the job pills under a turn. */
  tree: TreeNode[];
  /** Status per child conversation id, and the reply count shown on a pill. */
  jobStatus(conversation: number): RunStatus;
  /** The conversation runs now, so its newest turn is live. */
  running: boolean;
  /** Tool calls running now, from tool_execution_start. */
  runningTools?: Set<string>;
  /** The conversation's first entry: in a job it is its parent's task, so its author is the parent. */
  firstEntry?: number;
  /** A job's parent agent, the author of its task. */
  parent?: Principal;
}

export const entryKey = (id: number): string => `e${id}`;
export const turnKey = (firstEntry: number): string => `t${firstEntry}`;
/** The entry id in an item id or cursor, `e12` or `t12`. */
export function entryOf(key: string | undefined): number | undefined {
  const match = /^[et](\d+)$/.exec(key ?? "");
  return match ? Number(match[1]) : undefined;
}

function blocks(message: Message | undefined): ContentBlock[] {
  if (!message) return [];
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}
const textOf = (message: Message | undefined): string => blocks(message).flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n");

export function isInput(entry: EntryRecord): boolean {
  if (INPUT_KINDS.has(entry.kind)) return true;
  return entry.model?.[0]?.role === "user" && !TURN_KINDS.has(entry.kind);
}

const imageRefs = (thread: string, entry: EntryRecord): ImageRef[] =>
  blocks(entry.model?.[0]).flatMap((b, index) => (b.type === "image" ? [{ url: `/api/images/${thread}/${entry.id}/${index}`, mimeType: b.mimeType }] : []));

/** One line that says what a tool call does, from its name and arguments. */
export function toolSummary(name: string, args: Record<string, unknown>): string {
  const pick = ["command", "path", "file_path", "pattern", "query", "url", "task", "code"].find(key => typeof args[key] === "string");
  const value = pick ? String(args[pick]) : JSON.stringify(args);
  const line = value.split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

const SUBAGENT_TOOLS = new Set(["subagent"]);

/** A turn's id is its input's entry id, so the live turn keeps one id from the moment the input lands. */
interface TurnDraft { key: number; entries: EntryRecord[] }

function buildTurn(draft: TurnDraft, ctx: TimelineContext, live: boolean): Item {
  const steps: Step[] = [];
  const toolIndex = new Map<string, number>();
  const texts: string[] = [];
  const images: ImageRef[] = [];
  const jobs: JobRef[] = [];
  let stop: "aborted" | "error" | undefined;
  let error: string | undefined;
  let model: string | undefined;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let at = 0;
  for (const entry of draft.entries) {
    const message = entry.model?.[0];
    if (!message) continue;
    at ||= message.timestamp ?? 0;
    if (message.role === "assistant") {
      if (message.provider && message.model) model = `${message.provider}/${message.model}`;
      if (message.usage) {
        usage.input += message.usage.input;
        usage.output += message.usage.output;
        usage.cacheRead += message.usage.cacheRead;
        usage.cacheWrite += message.usage.cacheWrite;
        usage.cost += message.usage.cost?.total ?? 0;
      }
      // Only the newest model call says how the turn ended: a retried slot wait or overload before it is no failure.
      stop = message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : undefined;
      error = message.stopReason === "error" ? message.errorMessage ?? "The model call failed." : undefined;
      for (const block of blocks(message)) {
        if (block.type === "text" && block.text.trim()) texts.push(block.text);
        else if (block.type === "thinking" && block.thinking.trim()) steps.push({ kind: "thinking", text: block.thinking });
        else if (block.type === "toolCall") {
          toolIndex.set(block.id, steps.length);
          const running = live && (ctx.runningTools?.has(block.id) ?? true);
          const step: Step = { kind: "tool", id: block.id, name: block.name, summary: toolSummary(block.name, block.arguments ?? {}), status: running ? "running" : "done" };
          if (SUBAGENT_TOOLS.has(block.name)) {
            const task = String(block.arguments?.task ?? "");
            const node = ctx.tree.find(n => n.parent === ctx.conversation && task.startsWith(n.name.replace(/\.\.\.$|…$/, "")));
            if (node) step.job = `${ctx.thread}:${node.id}`;
          }
          steps.push(step);
        }
      }
    } else if (message.role === "toolResult") {
      const index = message.toolCallId ? toolIndex.get(message.toolCallId) : undefined;
      const output = textOf(message);
      const childId = typeof message.details?.conversationId === "number" ? (message.details.conversationId as number) : undefined;
      if (index !== undefined) {
        const step = steps[index] as Extract<Step, { kind: "tool" }>;
        step.status = message.isError ? "error" : "done";
        step.output = output.length > 4000 ? `${output.slice(0, 4000)}\n...` : output;
        if (childId !== undefined) step.job = `${ctx.thread}:${childId}`;
      }
      images.push(...imageRefs(ctx.thread, entry));
    }
  }
  for (const step of steps) {
    if (step.kind !== "tool" || !step.job) continue;
    const id = Number(step.job.split(":")[1]);
    const node = ctx.tree.find(n => n.id === id);
    jobs.push({ conversation: step.job, name: node?.name ?? step.summary, status: ctx.jobStatus(id), replies: 0, lastAt: node?.createdAt ?? at });
  }
  return {
    kind: "turn", id: turnKey(draft.key), at, author: ctx.agent, text: texts.join("\n\n"), live, steps, images, jobs,
    ...(stop ? { stop } : {}), ...(error ? { error } : {}), ...(model ? { model } : {}), usage,
  };
}

function inputItem(entry: EntryRecord, ctx: TimelineContext, first: boolean): Item {
  const message = entry.model?.[0];
  const data = (entry.data ?? {}) as { from?: string; via?: string };
  const author = entry.kind === "agent.message" && data.from ? ctx.principal(data.from) : first && ctx.parent ? ctx.parent : ctx.principal("owner");
  return { kind: "message", id: entryKey(entry.id), at: message?.timestamp ?? 0, author, text: textOf(message), images: imageRefs(ctx.thread, entry), mentions: [], deliveries: [] };
}

/** Items for entries given oldest first. The newest turn is live while the conversation runs. */
export function buildItems(entries: readonly EntryRecord[], ctx: TimelineContext): Item[] {
  const items: Item[] = [];
  let turn: TurnDraft | undefined;
  let lastInput: number | undefined;
  const flush = (live: boolean) => {
    if (turn) items.push(buildTurn(turn, ctx, live));
    turn = undefined;
  };
  for (const entry of entries) {
    if (entry.conversationId !== ctx.conversation) continue;
    if (isInput(entry)) {
      flush(false);
      items.push(inputItem(entry, ctx, entry.id === ctx.firstEntry));
      lastInput = entry.id;
    } else if (TURN_KINDS.has(entry.kind)) {
      turn ??= { key: lastInput ?? entry.id, entries: [] };
      turn.entries.push(entry);
    } else if (entry.kind === "pi.compaction") {
      flush(false);
      lastInput = undefined;
      items.push({ kind: "system", id: entryKey(entry.id), at: entry.model?.[0]?.timestamp ?? 0, text: "Earlier messages were summarized to free context.", avatars: [] });
    }
  }
  flush(ctx.running);
  if (ctx.running && items.at(-1)?.kind === "message") {
    const last = items.at(-1)!;
    items.push({ kind: "turn", id: turnKey(entryOf(last.id)!), at: last.at, author: ctx.agent, text: "", live: true, steps: [], images: [], jobs: [] });
  }
  return items;
}

/** The item id that holds `entryId` in entries given oldest first. */
export function itemIdFor(entries: readonly EntryRecord[], entryId: number): string | undefined {
  let lastInput: number | undefined;
  let turnStart: number | undefined;
  for (const entry of entries) {
    if (isInput(entry)) {
      lastInput = entry.id;
      turnStart = undefined;
    } else if (entry.kind === "pi.compaction") {
      lastInput = undefined;
      turnStart = undefined;
    } else if (TURN_KINDS.has(entry.kind)) turnStart ??= lastInput ?? entry.id;
    if (entry.id === entryId) return isInput(entry) || entry.kind === "pi.compaction" ? entryKey(entry.id) : turnStart === undefined ? undefined : turnKey(turnStart);
  }
  return undefined;
}
