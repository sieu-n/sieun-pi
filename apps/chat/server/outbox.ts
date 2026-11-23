/**
 * The owner's sends to a thread, held by the chat server until pi-host has them in the agent's context. The chat server is the
 * messaging service, as Slack is: a send is on disk and on every watching page before the HTTP answer, and the hop to pi-host
 * runs behind it with retries. Before this, the answer waited on pi-host and pi-pool's owner-turn mark, the composer stayed
 * locked meanwhile, and a steer into a long turn showed only as a faded pending row that vanished on reload.
 *
 * A row's life: `sending` (pi-host has not taken it) -> `sent` (pi-host admitted it, maybe as a steer waiting in the inbox)
 * -> gone, once an owner input with its text shows in the conversation. `failed` is only for a send pi-host refuses for good,
 * and it stays until the owner retries or discards it.
 */
import type { AgentId, ConversationId, Delivery, ImageRef, Item, SendState } from "../web/src/lib/api/types.ts";
import type { EntryRecord, Host, SubmitInput, Submitted } from "./host/types.ts";
import { withFileCards } from "./files.ts";
import { patchRow, type OutboxLog, type Patch } from "./outbox-db.ts";
import { isInput } from "./timeline.ts";
import { OWNER, parseConversationId } from "./threads.ts";

export interface OutboxRow {
  requestId: string;
  conversation: ConversationId;
  text: string;
  images: ImageRef[];
  mentions: AgentId[];
  whenBusy: "steer" | "followUp";
  at: number;
  state: SendState;
  attempts: number;
  error?: string;
  sentAt?: number;
  deliveries: Delivery[];
  /** The mentions in the send went out, so a restart does not send them again. */
  mentioned?: boolean;
}

/**
 * A send to pi-host that no page shows as the owner's pending row: an @mention, the owner's `[board]` line, an edit or delete notice. It
 * stays in the outbox file until pi-host takes it, and tries again after `retryWait`, after a restart of this server too, under its one
 * request id, so a try that landed while its answer was lost lands once (`Outbox.submit`).
 */
export interface KeptSubmit { thread: string; input: SubmitInput & { requestId: string }; at: number }

/** Retry waits grow to this and stay there. A soft cap: the send keeps trying until pi-host takes it or refuses it for good. */
const MAX_BACKOFF_MS = 30_000;
/** The wait before try `attempts + 1` of a send to pi-host, after `attempts` failed. */
export const retryWait = (attempts: number): number => Math.min(MAX_BACKOFF_MS, 250 * 2 ** Math.min(attempts, 10));
/** Whether pi-host refused a send for good, so no retry changes the answer. */
export const refusedForGood = (message: string): boolean => FATAL.test(message);
/** A sent row no input matched after this long is dropped from the overlay; pi-host has it, and its own entry shows on reload. */
const SENT_TTL_MS = 6 * 3600_000;
const SWEEP_MS = 3000;
/** Finished request ids are kept this long, so a send repeated after its row landed does not show a second time. */
const DONE_TTL_MS = 24 * 3600_000;
/** An input this much older than its row is not the row's; the chat server and pi-host share one clock. */
const LAND_SLACK_MS = 10_000;
/** pi-host's answers that no retry changes. */
const FATAL = /no thread|no conversation|needs text|archived/i;

export interface OutboxDeps {
  host: Host;
  /** pi-host's place for the run, so the page shows "queued" while it waits for a slot. */
  submitted(row: OutboxRow, result: Submitted): void;
  /**
   * Ends once a new thread's first agent.ref write ends (agents.ts `refWritten`), so a send right after POST /api/agents runs with the
   * thread's role. The create's answer does not wait for that write; the send waits here, behind its own answer.
   */
  refWritten(thread: string): Promise<boolean>;
  /** Delivers each @mention in the send to that agent, after the send itself reached pi-host. */
  mentions(row: OutboxRow): Promise<Delivery[]>;
  /** Items changed, and items gone (a row that landed or was discarded), for the conversation's watchers. */
  changed(conversation: ConversationId, items: Item[], removed: string[]): void;
  /** Reads an upload back for a send to pi-host. */
  image(ref: ImageRef): { data: string; mimeType: string } | undefined;
  /** A send's text with a line for each attached file that is not an image, naming its path (server/files.ts). */
  fileNotes(text: string, refs: readonly ImageRef[]): string;
  log(line: string): void;
}

export class Outbox {
  private readonly rows: Map<string, OutboxRow>;
  private readonly kept: Map<string, KeptSubmit>;
  private readonly done: Map<string, number>;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Set<string>();
  /** Input entries each conversation already matched to a row, so two sends of one text land as two. */
  private readonly matched = new Map<ConversationId, Set<string>>();
  /** The newest entry the sweep read per conversation. */
  private readonly swept = new Map<ConversationId, number>();
  private sweeper?: NodeJS.Timeout;
  private sweeping = false;
  private stopped = false;

  /** `log` is where the rows are kept: `outbox.jsonl`, or chat.sqlite once APPS_CHAT_DB_KINDS names `outbox` (outbox-db.ts). */
  constructor(private readonly log: OutboxLog, private readonly deps: OutboxDeps) {
    const state = log.load();
    this.rows = state.rows;
    this.kept = state.kept;
    this.done = state.done;
    this.compact();
  }

  /** Drops the finished ids older than a day, and keeps only the open rows and the recent finished ids. */
  private compact(): void {
    const now = Date.now();
    const gone = [...this.done].filter(([, at]) => now - at > DONE_TTL_MS).map(([id]) => id);
    for (const id of gone) this.done.delete(id);
    this.log.compact({ rows: this.rows, kept: this.kept, done: this.done }, gone);
  }

  /** Settles once every change to the outbox so far is stored. */
  written(): Promise<void> {
    return this.log.written();
  }

  /** Starts delivering every row a restart left open, and the sweep that finds landed rows. */
  start(): void {
    this.stopped = false;
    for (const row of this.rows.values()) {
      if (row.state === "sending") this.schedule(row, 0);
      else if (row.state === "sent" && row.mentions.length && !row.mentioned) void this.mention(row);
    }
    for (const send of this.kept.values()) this.timers.set(send.input.requestId, setTimeout(() => void this.submitKept(send, 0).catch(() => undefined), 0));
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.sweeper);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  get(requestId: string): OutboxRow | undefined {
    return this.rows.get(requestId);
  }

  /**
   * Writes the send and shows it on every watching page; the hop to pi-host starts right after. A repeated request id lands once: an
   * open row answers as it stands (and a failed one tries again), and a row that already landed answers as sent.
   */
  add(input: Omit<OutboxRow, "state" | "attempts" | "deliveries" | "at">): Item {
    const existing = this.rows.get(input.requestId);
    if (existing) return existing.state === "failed" ? this.retry(existing.requestId)! : this.item(existing);
    if (this.done.has(input.requestId)) return this.item({ ...input, at: Date.now(), state: "sent", attempts: 1, deliveries: [] });
    const row: OutboxRow = { ...input, at: Date.now(), state: "sending", attempts: 0, deliveries: [] };
    this.rows.set(row.requestId, row);
    this.log.row(row);
    this.deps.changed(row.conversation, [this.item(row)], []);
    this.schedule(row, 0);
    return this.item(row);
  }

  /** The rows of one conversation that pi-host has not shown as entries yet, oldest first. */
  items(conversation: ConversationId): Item[] {
    return this.open(conversation).map(r => this.item(r));
  }

  private open(conversation: ConversationId): OutboxRow[] {
    return [...this.rows.values()].filter(r => r.conversation === conversation).sort((a, b) => a.at - b.at);
  }

  /** Drops each row whose text now shows as an owner input in `items`, which pi-host read for that conversation. */
  reconcile(conversation: ConversationId, items: readonly Item[]): void {
    const rows = this.open(conversation).filter(r => r.state !== "failed");
    if (!rows.length) return;
    const inputs = items
      .filter((item): item is Extract<Item, { kind: "message" }> => item.kind === "message" && !item.id.startsWith("r:") && item.author.id === "owner")
      .map(item => ({ id: item.id, text: item.text, at: item.at }));
    this.land(conversation, rows, inputs);
  }

  /** Pairs rows with owner inputs, oldest first, each input once, and finishes the rows that found theirs. */
  private land(conversation: ConversationId, rows: OutboxRow[], inputs: { id: string; text: string; at: number }[]): void {
    const used = this.matched.get(conversation) ?? new Set<string>();
    const gone: string[] = [];
    for (const row of rows) {
      const input = inputs.find(i => !used.has(i.id) && sameText(i.text, row.text) && i.at >= row.at - LAND_SLACK_MS);
      if (!input) continue;
      used.add(input.id);
      gone.push(this.finish(row));
    }
    if (used.size > 200) this.matched.set(conversation, new Set([...used].slice(-100)));
    else this.matched.set(conversation, used);
    if (gone.length) this.deps.changed(conversation, [], gone);
  }

  /** Tries a row again now, from the page's Retry. */
  retry(requestId: string): Item | undefined {
    const row = this.rows.get(requestId);
    if (!row) return undefined;
    if (row.state === "failed") this.set(row, { state: "sending", error: null });
    if (row.state === "sending") this.schedule(row, 0);
    return this.item(row);
  }

  /** Drops a row the owner gave up on. pi-host never had a failed row; an open one may still land, as its own entry. */
  discard(requestId: string): boolean {
    const row = this.rows.get(requestId);
    if (!row) return false;
    const id = this.finish(row);
    this.deps.changed(row.conversation, [], [id]);
    return true;
  }

  item(row: OutboxRow): Item {
    return {
      kind: "message", id: `r:${row.requestId}`, at: row.at, author: OWNER, text: row.text, images: row.images, mentions: row.mentions,
      deliveries: row.deliveries, pending: true, send: row.state, requestId: row.requestId, ...(row.error ? { sendError: row.error } : {}),
    };
  }

  private set(row: OutboxRow, change: Patch): void {
    patchRow(row, change);
    this.log.set(row, change);
    if (this.rows.has(row.requestId)) this.deps.changed(row.conversation, [this.item(row)], []);
  }

  private finish(row: OutboxRow): string {
    clearTimeout(this.timers.get(row.requestId));
    this.timers.delete(row.requestId);
    this.rows.delete(row.requestId);
    const at = Date.now();
    this.done.set(row.requestId, at);
    this.log.done(row.requestId, at);
    if (!this.rows.size && !this.kept.size && this.done.size > 500) this.compact();
    return `r:${row.requestId}`;
  }

  /**
   * Keeps `input` on disk and hands it to pi-host once `after` settles, then again after `retryWait` until pi-host takes it (`KeptSubmit`).
   * Answers pi-host's answer when the first try lands, and undefined when the send waits for a retry or its request id was handed already.
   * Throws when pi-host refuses it for good, which no retry changes.
   */
  async submit(thread: string, input: KeptSubmit["input"], after?: Promise<unknown>): Promise<Submitted | undefined> {
    if (this.kept.has(input.requestId) || this.done.has(input.requestId)) return undefined;
    const send: KeptSubmit = { thread, input, at: Date.now() };
    this.kept.set(input.requestId, send);
    this.log.kept(send);
    await after;
    return this.submitKept(send, 0);
  }

  private async submitKept(send: KeptSubmit, attempts: number): Promise<Submitted | undefined> {
    const id = send.input.requestId;
    this.timers.delete(id);
    if (this.stopped || !this.kept.has(id) || this.inflight.has(id)) return undefined;
    this.inflight.add(id);
    try {
      const result = await this.deps.host.submit(send.thread, send.input);
      this.endKept(id);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (refusedForGood(message)) {
        this.deps.log(`outbox: ${id} to ${send.thread} refused: ${message}`);
        this.endKept(id);
        throw error;
      }
      const wait = retryWait(attempts + 1);
      this.deps.log(`outbox: ${id} to ${send.thread} attempt ${attempts + 1} failed, retry in ${wait} ms: ${message}`);
      if (!this.stopped) this.timers.set(id, setTimeout(() => void this.submitKept(send, attempts + 1).catch(() => undefined), wait));
      return undefined;
    } finally {
      this.inflight.delete(id);
    }
  }

  private endKept(requestId: string): void {
    this.kept.delete(requestId);
    const at = Date.now();
    this.done.set(requestId, at);
    this.log.done(requestId, at);
  }

  private schedule(row: OutboxRow, delay: number): void {
    if (this.stopped) return;
    clearTimeout(this.timers.get(row.requestId));
    this.timers.set(row.requestId, setTimeout(() => void this.deliver(row), delay));
  }

  private async deliver(row: OutboxRow): Promise<void> {
    this.timers.delete(row.requestId);
    if (this.stopped || !this.rows.has(row.requestId) || row.state !== "sending" || this.inflight.has(row.requestId)) return;
    this.inflight.add(row.requestId);
    const { thread, conversation } = parseConversationId(row.conversation);
    const images = row.images.map(ref => this.deps.image(ref)).filter((image): image is { data: string; mimeType: string } => !!image);
    try {
      await this.deps.refWritten(thread);
      if (this.stopped || !this.rows.has(row.requestId)) return;
      const result = await this.deps.host.submit(thread, {
        ...(conversation === 1 ? {} : { conversation }), text: this.deps.fileNotes(row.text, row.images), ...(images.length ? { images } : {}),
        requestId: row.requestId, whenBusy: row.whenBusy, ownerTurn: true,
      });
      // The input can land, and drop the row, before pi-host's answer comes back; its place and mentions still go out.
      if (this.rows.has(row.requestId)) this.set(row, { state: "sent", sentAt: Date.now(), attempts: row.attempts + 1, error: null });
      this.deps.submitted(row, result);
      if (row.mentions.length) await this.mention(row);
    } catch (error) {
      if (!this.rows.has(row.requestId)) return;
      const message = error instanceof Error ? error.message : String(error);
      const attempts = row.attempts + 1;
      if (refusedForGood(message)) {
        this.deps.log(`outbox: ${row.requestId} to ${row.conversation} refused: ${message}`);
        this.set(row, { state: "failed", attempts, error: message });
        return;
      }
      const wait = retryWait(attempts);
      this.deps.log(`outbox: ${row.requestId} to ${row.conversation} attempt ${attempts} failed, retry in ${wait} ms: ${message}`);
      // The row stays `sending`; after a few tries the page shows the reason, so a long pi-host restart is visible.
      this.set(row, { attempts, ...(attempts >= 3 ? { error: message } : {}) });
      this.schedule(row, wait);
    } finally {
      this.inflight.delete(row.requestId);
    }
  }

  private async mention(row: OutboxRow): Promise<void> {
    try {
      const deliveries = await this.deps.mentions(row);
      if (this.rows.has(row.requestId)) this.set(row, { deliveries, mentioned: true });
    } catch (error) {
      this.deps.log(`outbox: mentions of ${row.requestId} failed: ${String(error)}`);
    }
  }

  /**
   * Reads the entries of each conversation with a row pi-host took, and drops the rows that landed there. A watched conversation
   * lands its rows from the live items too; this covers the rest, and an input that landed while no page watched.
   */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const byConversation = new Map<ConversationId, OutboxRow[]>();
      for (const row of this.rows.values()) {
        if (row.state === "failed" || (row.state === "sending" && row.attempts === 0)) continue;
        if (row.state === "sent" && Date.now() - (row.sentAt ?? row.at) > SENT_TTL_MS) {
          this.deps.changed(row.conversation, [], [this.finish(row)]);
          continue;
        }
        byConversation.set(row.conversation, [...(byConversation.get(row.conversation) ?? []), row]);
      }
      for (const [id, rows] of byConversation) {
        const { thread, conversation } = parseConversationId(id);
        try {
          const cursor = this.swept.get(id);
          const page = cursor === undefined
            ? await this.deps.host.entries(thread, { conversation, limit: 50 })
            : await this.deps.host.entries(thread, { conversation, after: cursor, limit: 200 });
          const entries = [...page.entries].sort((a, b) => a.id - b.id);
          const newest = entries.at(-1)?.id;
          if (newest !== undefined) this.swept.set(id, Math.max(cursor ?? 0, newest));
          const open = rows.filter(r => this.rows.has(r.requestId)).sort((a, b) => a.at - b.at);
          this.land(id, open, entries.filter(ownerInput).map(e => ({ id: `e${e.id}`, text: withFileCards(entryText(e), []).text, at: e.model?.[0]?.timestamp ?? 0 })));
        } catch {
          // pi-host is away; the next sweep tries again.
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}

const ownerInput = (entry: EntryRecord): boolean => isInput(entry) && entry.kind !== "agent.message";

function entryText(entry: EntryRecord): string {
  const content = entry.model?.[0]?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n");
}

const sameText = (a: string, b: string): boolean => a.trim() === b.trim();
