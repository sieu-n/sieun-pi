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
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, ConversationId, Delivery, ImageRef, Item, SendState } from "../web/src/lib/api/types.ts";
import type { EntryRecord, Host, Submitted } from "./host/types.ts";
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

/** A `set` patch writes null for a field it clears, since JSON drops undefined. */
type Patch = { [K in keyof OutboxRow]?: OutboxRow[K] | null };
type Line = { t: "row"; row: OutboxRow } | { t: "set"; requestId: string; patch: Patch } | { t: "done"; requestId: string; at?: number };

/** Retry waits grow to this and stay there. A soft cap: the send keeps trying until pi-host takes it or refuses it for good. */
const MAX_BACKOFF_MS = 30_000;
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
  /** Delivers each @mention in the send to that agent, after the send itself reached pi-host. */
  mentions(row: OutboxRow): Promise<Delivery[]>;
  /** Items changed, and items gone (a row that landed or was discarded), for the conversation's watchers. */
  changed(conversation: ConversationId, items: Item[], removed: string[]): void;
  /** Reads an upload back for a send to pi-host. */
  image(ref: ImageRef): { data: string; mimeType: string } | undefined;
  log(line: string): void;
}

export class Outbox {
  private readonly rows = new Map<string, OutboxRow>();
  private readonly done = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Set<string>();
  /** Input entries each conversation already matched to a row, so two sends of one text land as two. */
  private readonly matched = new Map<ConversationId, Set<string>>();
  /** The newest entry the sweep read per conversation. */
  private readonly swept = new Map<ConversationId, number>();
  private sweeper?: NodeJS.Timeout;
  private sweeping = false;
  private stopped = false;
  private readonly file: string;

  constructor(dir: string, private readonly deps: OutboxDeps) {
    this.file = join(dir, "outbox.jsonl");
    this.load();
  }

  private load(): void {
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      if (line.t === "row") this.rows.set(line.row.requestId, line.row);
      else if (line.t === "set") {
        const row = this.rows.get(line.requestId);
        if (row) patch(row, line.patch);
      } else {
        this.rows.delete(line.requestId);
        this.done.set(line.requestId, line.at ?? Date.now());
      }
    }
    this.compact();
  }

  /** Rewrites the file with the open rows and the recent finished ids only. */
  private compact(): void {
    const now = Date.now();
    for (const [id, at] of this.done) if (now - at > DONE_TTL_MS) this.done.delete(id);
    const lines: Line[] = [
      ...[...this.done].map(([requestId, at]): Line => ({ t: "done", requestId, at })),
      ...[...this.rows.values()].map((row): Line => ({ t: "row", row })),
    ];
    writeFileSync(this.file, lines.map(line => `${JSON.stringify(line)}\n`).join(""));
  }

  private write(line: Line): void {
    try {
      appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.deps.log(`outbox: could not write ${this.file}: ${String(error)}`);
    }
  }

  /** Starts delivering every row a restart left open, and the sweep that finds landed rows. */
  start(): void {
    this.stopped = false;
    for (const row of this.rows.values()) {
      if (row.state === "sending") this.schedule(row, 0);
      else if (row.state === "sent" && row.mentions.length && !row.mentioned) void this.mention(row);
    }
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
    this.write({ t: "row", row });
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
    patch(row, change);
    this.write({ t: "set", requestId: row.requestId, patch: change });
    if (this.rows.has(row.requestId)) this.deps.changed(row.conversation, [this.item(row)], []);
  }

  private finish(row: OutboxRow): string {
    clearTimeout(this.timers.get(row.requestId));
    this.timers.delete(row.requestId);
    this.rows.delete(row.requestId);
    const at = Date.now();
    this.done.set(row.requestId, at);
    this.write({ t: "done", requestId: row.requestId, at });
    if (!this.rows.size && this.done.size > 500) this.compact();
    return `r:${row.requestId}`;
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
      const result = await this.deps.host.submit(thread, {
        ...(conversation === 1 ? {} : { conversation }), text: row.text, ...(images.length ? { images } : {}),
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
      if (FATAL.test(message)) {
        this.deps.log(`outbox: ${row.requestId} to ${row.conversation} refused: ${message}`);
        this.set(row, { state: "failed", attempts, error: message });
        return;
      }
      const wait = Math.min(MAX_BACKOFF_MS, 250 * 2 ** Math.min(attempts, 10));
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
          this.land(id, open, entries.filter(ownerInput).map(e => ({ id: `e${e.id}`, text: entryText(e), at: e.model?.[0]?.timestamp ?? 0 })));
        } catch {
          // pi-host is away; the next sweep tries again.
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}

function patch(row: OutboxRow, change: Patch): void {
  for (const [key, value] of Object.entries(change)) {
    if (value === null || value === undefined) delete (row as unknown as Record<string, unknown>)[key];
    else (row as unknown as Record<string, unknown>)[key] = value;
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
