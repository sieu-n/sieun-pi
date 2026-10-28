/**
 * An in-memory `Host` for fixture mode and tests. It keeps threads, conversations, entries and documents the way pi-durable shapes them,
 * and answers each input with a streamed reply, so pages see partial text, tool steps, jobs, Stop and status without pi-host.
 * A message that says "spawn" starts a job (a child conversation), "fail" ends the turn with an error, "slow" streams for a minute, and
 * "queue" waits two seconds in a fake turn queue (place 3 of 7, then 1 of 7) before it starts.
 */
import { randomUUID } from "node:crypto";
import type { TurnPlace } from "../../web/src/lib/api/types.ts";
import { DEFAULT_MODEL } from "../config.ts";
import type { ContentBlock, DurableEvent, DurableThread, EntryRecord, Host, Message, SearchHit, SearchPage, SearchQuery, SubmissionRecord, Submitted, SubmitInput, Ticket, TreeNode, UsageTotal } from "./types.ts";

interface FakeThread {
  row: DurableThread;
  nodes: TreeNode[];
  entries: EntryRecord[];
  docs: Map<string, unknown>;
  nextId: number;
  submissions: Map<number, SubmissionRecord>;
  byRequest: Map<string, number>;
  running: Map<number, { stop: () => void }>;
  waiters: Map<number, ((record: SubmissionRecord) => void)[]>;
  /** Inputs that wait for the running turn of their conversation, as `whenBusy: followUp`. */
  queued: Map<number, (() => void)[]>;
  /** Each conversation's place in the fake turn queue. */
  places: Map<number, TurnPlace>;
}

type Sink = { conversation?: number; sink: (event: DurableEvent) => void };

const USAGE = (output: number) => ({ input: 40, output, cacheRead: 12_000, cacheWrite: 800, cost: { input: 0.00016, output: output * 0.00002, cacheRead: 0.0024, cacheWrite: 0.0064, total: 0.00896 + output * 0.00002 } });

export class FixtureHost implements Host {
  readonly name = "fixture";
  readonly threadsById = new Map<string, FakeThread>();
  private readonly sinks = new Map<string, Set<Sink>>();
  /** Milliseconds between streamed words; tests set 0. */
  wordMs = 40;
  /** Runs before each submit; a test makes pi-host slow (a promise that waits) or away (a throw). */
  beforeSubmit?: (thread: string, input: SubmitInput) => void | Promise<void>;
  now = () => Date.now();

  // Seeding

  addThread(input: { id?: string; name: string; status?: DurableThread["status"]; createdAt: number; model?: string; archived?: boolean }): FakeThread {
    const id = input.id ?? randomUUID();
    const [provider, modelId] = (input.model ?? DEFAULT_MODEL).split("/");
    const thread: FakeThread = {
      row: {
        id, name: input.name, provider: provider!, modelId: modelId!, thinkingLevel: "high", cwd: "/home/sieun", createdAt: input.createdAt, updatedAt: input.createdAt,
        failed: input.status === "failed", archived: input.archived ?? false, preview: "", children: 0, status: input.status ?? "idle",
      },
      nodes: [{ id: 1, parent: null, ownerTask: null, name: input.name, depth: 0, status: "idle", model: input.model ?? DEFAULT_MODEL, createdAt: input.createdAt }],
      entries: [], docs: new Map(), nextId: 2, submissions: new Map(), byRequest: new Map(), running: new Map(), waiters: new Map(), queued: new Map(), places: new Map(),
    };
    this.threadsById.set(id, thread);
    return thread;
  }

  append(thread: FakeThread, conversation: number, draft: Omit<EntryRecord, "id" | "conversationId">): EntryRecord {
    const entry: EntryRecord = { id: thread.nextId++, conversationId: conversation, ...draft };
    thread.entries.push(entry);
    const at = entry.model?.[0]?.timestamp ?? this.now();
    thread.row.updatedAt = Math.max(thread.row.updatedAt, at);
    const message = entry.model?.[0];
    if (conversation === 1 && message?.role === "assistant") {
      const text = Array.isArray(message.content) ? message.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n") : message.content;
      if (text) thread.row.preview = text.slice(0, 200);
    }
    this.emit(thread, { type: "events", conversation, events: [{ type: "entry_appended", entry }] });
    return entry;
  }

  addChild(thread: FakeThread, parent: number, name: string, at: number, status: "idle" | "running" = "idle"): TreeNode {
    const id = thread.nextId++;
    const parentNode = thread.nodes.find(n => n.id === parent)!;
    const node: TreeNode = { id, parent, ownerTask: id - 1, name: name.slice(0, 80), depth: parentNode.depth + 1, status, model: parentNode.model, createdAt: at };
    thread.nodes.push(node);
    thread.row.children = thread.nodes.length - 1;
    this.emit(thread, { type: "conversation", node });
    return node;
  }

  private emit(thread: FakeThread, event: DurableEvent): void {
    for (const sink of this.sinks.get(thread.row.id) ?? []) {
      if (event.type === "events" && sink.conversation !== undefined && sink.conversation !== event.conversation) continue;
      sink.sink(event);
    }
  }

  private setStatus(thread: FakeThread, status: DurableThread["status"]): void {
    thread.row.status = status;
    thread.row.failed = status === "failed";
    thread.row.updatedAt = this.now();
    this.emit(thread, { type: "status", status });
  }

  private get(id: string): FakeThread {
    const thread = this.threadsById.get(id);
    if (!thread) throw new Error(`No thread ${id}`);
    return thread;
  }

  // Host

  async threads(opts: { archived?: boolean } = {}): Promise<DurableThread[]> {
    return [...this.threadsById.values()].map(t => ({ ...t.row })).filter(t => opts.archived === undefined || t.archived === opts.archived);
  }

  async create(opts: { name?: string; model?: string; thinkingLevel?: string; cwd?: string }): Promise<DurableThread> {
    const thread = this.addThread({ name: opts.name ?? "New thread", createdAt: this.now(), ...(opts.model ? { model: opts.model } : {}) });
    if (opts.thinkingLevel) thread.row.thinkingLevel = opts.thinkingLevel;
    return { ...thread.row };
  }

  async submit(id: string, input: SubmitInput): Promise<Submitted> {
    await this.beforeSubmit?.(id, input);
    const thread = this.get(id);
    if (input.requestId && thread.byRequest.has(input.requestId)) return { submission: thread.byRequest.get(input.requestId)!, status: "placed", ticket: this.ticketOf(thread, input.conversation ?? 1) };
    const conversation = input.conversation ?? 1;
    if (!thread.nodes.some(n => n.id === conversation)) throw new Error(`No conversation ${conversation} in ${id}`);
    const content: ContentBlock[] = [{ type: "text", text: input.text ?? "" }, ...(input.images ?? []).map(i => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))];
    const user: Message = { role: "user", content, timestamp: this.now() };
    const entry = this.append(thread, conversation, input.entry ? { kind: "agent.message", model: [user], data: input.entry.data } : { kind: "pi.user", model: [user] });
    const submission: SubmissionRecord = { id: thread.nextId++, conversationId: conversation, ...(input.requestId ? { requestId: input.requestId } : {}), type: "input", status: "placed", entry: entry.id };
    thread.submissions.set(submission.id, submission);
    if (input.requestId) thread.byRequest.set(input.requestId, submission.id);
    const begin = () => {
      thread.places.set(conversation, { state: "working", kind: input.ownerTurn ? "owner" : "slot" });
      void this.answer(thread, conversation, submission, input.text ?? "");
    };
    const waits = /\bqueue\b/i.test(input.text ?? "") && this.wordMs > 0;
    const start = waits
      ? () => {
          thread.places.set(conversation, { state: "queued", position: 3, total: 7 });
          setTimeout(() => thread.places.set(conversation, { state: "queued", position: 1, total: 7 }), 1000);
          setTimeout(begin, 2000);
        }
      : begin;
    if (!thread.running.has(conversation)) start();
    else thread.queued.set(conversation, [...(thread.queued.get(conversation) ?? []), start]);
    return { submission: submission.id, status: "placed", ticket: this.ticketOf(thread, conversation), ...(input.ownerTurn ? { owner: { state: "off" as const } } : {}) };
  }

  private ticketOf(thread: FakeThread, conversation: number): Ticket {
    return { session: `${thread.row.id}:${conversation}`, tree: `pi-durable:${thread.row.id}`, place: thread.places.get(conversation) ?? { state: "none" } };
  }

  async ticket(id: string, conversation = 1): Promise<Ticket | null> {
    return this.ticketOf(this.get(id), conversation);
  }

  /** Streams an answer word by word as message_update events, then appends it. */
  async answer(thread: FakeThread, conversation: number, submission: SubmissionRecord, text: string, reply?: string): Promise<void> {
    const node = thread.nodes.find(n => n.id === conversation)!;
    let stopped = false;
    thread.running.set(conversation, { stop: () => (stopped = true) });
    node.status = "running";
    if (conversation === 1) this.setStatus(thread, "running");
    this.emit(thread, { type: "events", conversation, events: [{ type: "run_start", inputs: [submission.id] }] });
    const words = (reply ?? replyFor(text)).split(/(?<= )/);
    const slow = /\bslow\b/i.test(text);
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    if (/\bspawn\b/i.test(text)) {
      const callId = `call_${randomUUID().slice(0, 8)}`;
      const task = `Check the canary relay for the pi-host cutover (from: ${text.slice(0, 40)})`;
      this.append(thread, conversation, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "I'll hand this to a job." }, { type: "toolCall", id: callId, name: "subagent", arguments: { task } }], provider: "anthropic", model: "claude-opus-5-5", usage: USAGE(30), stopReason: "toolUse", timestamp: this.now() }] });
      this.emit(thread, { type: "events", conversation, events: [{ type: "tool_execution_start", toolCallId: callId, toolName: "subagent", args: { task } }] });
      const child = this.addChild(thread, conversation, task, this.now(), "running");
      this.append(thread, child.id, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: task }], timestamp: this.now() }] });
      await sleep(this.wordMs * 5);
      this.append(thread, child.id, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "The canary relay answers on :7791 and the send key works." }], provider: "anthropic", model: "claude-opus-5-5", usage: USAGE(20), stopReason: "stop", timestamp: this.now() }] });
      child.status = "idle";
      this.append(thread, conversation, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName: "subagent", content: [{ type: "text", text: "The canary relay answers on :7791 and the send key works." }], details: { conversationId: child.id }, isError: false, timestamp: this.now() }] });
      this.emit(thread, { type: "events", conversation, events: [{ type: "tool_execution_end", toolCallId: callId, toolName: "subagent" }] });
    }
    let sent = "";
    this.emit(thread, { type: "events", conversation, events: [{ type: "message_start", message: { role: "assistant", content: [], timestamp: this.now() } }] });
    for (const word of words) {
      if (stopped) break;
      sent += word;
      this.emit(thread, { type: "events", conversation, events: [{ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: word }] }] });
      if (this.wordMs) await sleep(slow ? 1000 : this.wordMs);
    }
    const failed = /\bfail\b/i.test(text);
    const message: Message = {
      role: "assistant", content: [{ type: "text", text: sent }], provider: "anthropic", model: "claude-opus-5-5", usage: USAGE(words.length * 2),
      stopReason: stopped ? "aborted" : failed ? "error" : "stop", ...(failed ? { errorMessage: "The model call failed: overloaded (fixture)." } : {}), timestamp: this.now(),
    };
    const answer = this.append(thread, conversation, { kind: "pi.assistant", model: [message] });
    this.emit(thread, { type: "events", conversation, events: [{ type: "message_end", entry: answer }, { type: "run_end", inputs: [submission.id] }] });
    thread.running.delete(conversation);
    thread.places.delete(conversation);
    node.status = "idle";
    submission.status = stopped || failed ? "unanswered" : "done";
    submission.answer = answer.id;
    this.emit(thread, { type: "events", conversation, events: [{ type: "submission", record: { ...submission } }] });
    if (conversation === 1) this.setStatus(thread, failed ? "failed" : "idle");
    for (const resolve of thread.waiters.get(submission.id) ?? []) resolve({ ...submission });
    thread.waiters.delete(submission.id);
    thread.queued.get(conversation)?.shift()?.();
  }

  async abort(id: string, conversation = 1): Promise<void> {
    this.get(id).running.get(conversation)?.stop();
  }

  async wait(id: string, submission: number): Promise<SubmissionRecord> {
    const thread = this.get(id);
    const record = thread.submissions.get(submission);
    if (!record) throw new Error(`No submission ${submission}`);
    if (record.status !== "placed") return { ...record };
    return new Promise(resolve => {
      const list = thread.waiters.get(submission) ?? [];
      list.push(resolve);
      thread.waiters.set(submission, list);
    });
  }

  async tree(id: string): Promise<TreeNode[]> {
    return this.get(id).nodes.map(n => ({ ...n }));
  }

  async entries(id: string, opts: { conversation?: number; before?: number; after?: number; limit?: number }): Promise<{ entries: EntryRecord[]; more: boolean }> {
    const conversation = opts.conversation ?? 1;
    const all = this.get(id).entries.filter(e => e.conversationId === conversation);
    const limit = opts.limit ?? 50;
    if (opts.after !== undefined) {
      const rest = all.filter(e => e.id > opts.after!);
      return { entries: rest.slice(0, limit), more: rest.length > limit };
    }
    const rest = all.filter(e => opts.before === undefined || e.id < opts.before).reverse();
    return { entries: rest.slice(0, limit), more: rest.length > limit };
  }

  async watch(id: string, opts: { conversation?: number; fromEntry?: number }, sink: (event: DurableEvent) => void): Promise<() => Promise<void>> {
    const thread = this.get(id);
    const entry: Sink = { ...(opts.conversation === undefined ? {} : { conversation: opts.conversation }), sink };
    const set = this.sinks.get(id) ?? new Set();
    set.add(entry);
    this.sinks.set(id, set);
    queueMicrotask(() => {
      sink({ type: "events", conversation: opts.conversation ?? 1, events: [{ type: "snapshot", tools: [], inbox: [] }] });
      sink({ type: "status", status: thread.row.status });
      const missed = thread.entries.filter(e => e.id > (opts.fromEntry ?? 0) && (opts.conversation === undefined || e.conversationId === opts.conversation));
      for (const e of missed) sink({ type: "events", conversation: e.conversationId, events: [{ type: "entry_appended", entry: e }] });
    });
    return async () => {
      set.delete(entry);
    };
  }

  async search(query: SearchQuery): Promise<SearchPage> {
    const words = query.q.toLowerCase().split(/\s+/).map(w => w.replace(/^"|"$|\*$/g, "")).filter(Boolean);
    type Match = { hit: Omit<SearchHit, "snippet">; text: string; score: number };
    const matches: Match[] = [];
    // pi-host's rules: a LIKE pattern leaves agent messages out, and copies of one entry show once, from an unarchived thread.
    const skip = query.skipAgentMessages ? new RegExp(`^${query.skipAgentMessages.split("%").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*")}$`, "i") : undefined;
    const copies = new Map<string, { archived: number; match: Match }>();
    for (const thread of this.threadsById.values()) {
      if (query.threads && !query.threads.includes(thread.row.id)) continue;
      for (const entry of thread.entries) {
        const message = entry.model?.[0];
        if (!message || message.role === "system") continue;
        // pi-host indexes a tool call as its name and JSON arguments beside the answer's text.
        const text = typeof message.content === "string" ? message.content : message.content.flatMap(b => (b.type === "text" ? [b.text] : b.type === "toolCall" ? [`${b.name} ${JSON.stringify(b.arguments ?? {})}`] : [])).join("\n");
        const lower = text.toLowerCase();
        const counts = words.map(w => lower.split(w).length - 1);
        if (!words.length || counts.some(c => c === 0)) continue;
        const at = message.timestamp ?? 0;
        if (query.after !== undefined && at < query.after) continue;
        if (query.before !== undefined && at >= query.before) continue;
        const author = entry.kind === "agent.message" ? String((entry.data as { from?: string }).from) : message.role === "user" ? "owner" : message.role === "assistant" ? `${message.provider}/${message.model}` : `tool:${message.toolName}`;
        if (query.from && author !== query.from) continue;
        if (query.notFrom && author === query.notFrom) continue;
        if (query.kinds?.length && !query.kinds.includes(entry.kind)) continue;
        if (query.skipKinds?.includes(entry.kind)) continue;
        if (query.conversation !== undefined && entry.conversationId !== query.conversation) continue;
        if (query.by && !(entry.kind === "agent.message" ? author === query.by.id : author !== "owner" && thread.row.id === query.by.thread && entry.conversationId === query.by.conversation)) continue;
        if (skip && entry.kind === "agent.message" && skip.test(text)) continue;
        const copyKey = `${entry.id} ${entry.kind} ${author} ${at}`;
        const copy = copies.get(copyKey);
        if (copy && (copy.archived <= Number(thread.row.archived))) continue;
        if (copy) matches.splice(matches.indexOf(copy.match), 1);
        const match: Match = { hit: { thread: thread.row.id, conversation: entry.conversationId, entryId: entry.id, kind: entry.kind, author, at }, text, score: counts.reduce((a, b) => a + b, 0) };
        matches.push(match);
        copies.set(copyKey, { archived: Number(thread.row.archived), match });
      }
    }
    const tier = (m: Match) => (query.sort !== "recent" && query.demoteKinds?.includes(m.hit.kind) ? 1 : 0);
    matches.sort((a, b) => (query.sort === "recent" ? b.hit.at - a.hit.at : tier(a) - tier(b) || b.score - a.score || b.hit.at - a.hit.at));
    const offset = query.offset ?? 0;
    const mark = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    const hits = matches.slice(offset, offset + (query.limit ?? 50)).map(({ hit, text }) => {
      const start = Math.max(0, text.toLowerCase().indexOf(words[0]!) - 40);
      return { ...hit, snippet: (start ? "…" : "") + text.slice(start, start + 160).replace(mark, "<mark>$1</mark>"), ...(query.withText ? { text } : {}) };
    });
    return { hits, total: matches.length };
  }

  async usage(range: { since?: number; until?: number; threads?: string[] }): Promise<UsageTotal[]> {
    const rows = new Map<string, UsageTotal>();
    for (const thread of this.threadsById.values()) {
      if (range.threads && !range.threads.includes(thread.row.id)) continue;
      for (const entry of thread.entries) {
        const message = entry.model?.[0];
        if (message?.role !== "assistant" || !message.usage) continue;
        const at = message.timestamp ?? 0;
        if (range.since !== undefined && at < range.since) continue;
        if (range.until !== undefined && at >= range.until) continue;
        const model = `${message.provider}/${message.model}`;
        const key = `${thread.row.id} ${model}`;
        const row = rows.get(key) ?? { thread: thread.row.id, model, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0 };
        row.turns += 1;
        row.input += message.usage.input;
        row.output += message.usage.output;
        row.cacheRead += message.usage.cacheRead;
        row.cacheWrite += message.usage.cacheWrite;
        row.cost += message.usage.cost.total;
        row.costInput += message.usage.cost.input;
        row.costOutput += message.usage.cost.output;
        row.costCacheRead += message.usage.cost.cacheRead;
        row.costCacheWrite += message.usage.cost.cacheWrite;
        rows.set(key, row);
      }
    }
    return [...rows.values()];
  }

  async docGet(id: string, name: string): Promise<unknown> {
    return this.get(id).docs.get(name) ?? null;
  }

  async docPut(id: string, name: string, value: unknown): Promise<void> {
    const thread = this.get(id);
    thread.docs.set(name, value);
    this.emit(thread, { type: "doc", conversation: 1, name, value });
  }

  async set(id: string, patch: { name?: string; model?: string; thinkingLevel?: string; archived?: boolean }): Promise<DurableThread> {
    const thread = this.get(id);
    if (patch.name !== undefined) thread.row.name = patch.name;
    if (patch.archived !== undefined) thread.row.archived = patch.archived;
    if (patch.thinkingLevel !== undefined) thread.row.thinkingLevel = patch.thinkingLevel;
    if (patch.model) {
      const [provider, ...rest] = patch.model.split("/");
      thread.row.provider = provider!;
      thread.row.modelId = rest.join("/");
    }
    thread.row.updatedAt = this.now();
    return { ...thread.row };
  }

  async ping(): Promise<{ ok: true; version: string }> {
    return { ok: true, version: "fixture" };
  }

  async close(): Promise<void> {
    for (const thread of this.threadsById.values()) for (const run of thread.running.values()) run.stop();
  }
}

function replyFor(text: string): string {
  if (/\bmermaid\b/i.test(text)) return "Here is the flow:\n\n```mermaid\nflowchart LR\n  owner --> chat --> pi-host\n```\n\nThe chat server sits in the middle.";
  if (/\bslow\b/i.test(text)) return Array.from({ length: 60 }, (_, i) => `word${i + 1}`).join(" ");
  return `Got it. You said: "${text.split("\n").find(line => line.trim() && !line.startsWith("["))?.slice(0, 120) ?? text.slice(0, 120)}". I checked the canary and the relay, and both answer.`;
}
