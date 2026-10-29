/**
 * Channels after ~/work/slack-layer-design/channels.md sections 3 and 4. A channel is a named room with members and one post log in the
 * chat server's data dir. A post that @mentions an agent goes to that agent's conversation as an `agent.message` input, and what the agent
 * sends with send_message in the turn it starts comes back into the post's thread, one post per call. Each mention is one delivery with its
 * own state. Members and mentions are stored as conversation ids, so an agent id (`ag_<slug>`) given here stands for its work thread.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentId, Channel, ChannelInput, TurnPlace, ConversationSummary, Delivery, DeliveryState, ImageRef, Item, Member, Principal, SendRequest, TimelinePage,
} from "../web/src/lib/api/types.ts";
import type { Host } from "./host/types.ts";
import type { ChannelRow, Post, Store, StoredDelivery } from "./store.ts";
import { waitingPlace } from "./queue.ts";
import { OWNER, parseConversationId, type Threads } from "./threads.ts";

/** Hard: money, an agent loop runs paid model turns nobody reads (channels.md 4.3). */
export const MAX_HOPS = 6;
const CONTEXT_POSTS = 5;
const CONTEXT_CLIP = 2048;
const PAGE = 50;

export interface ChannelEvents {
  /** Follows a delivery's place in pi-pool's turn queue until its run works or ends. */
  queue(target: AgentId, place: TurnPlace | null, listener: (place: TurnPlace | null) => void): void;
  items(conversation: string, items: Item[]): void;
  channel(channel: Channel): void;
  conversations(changed: ConversationSummary[]): void;
}

const ENVELOPE_TAIL = "what you send with send_message is posted back into this thread";
/**
 * A LIKE pattern for the copy of a post that `envelope` sends into a thread; search finds the post itself in its channel. It also matches
 * the tail copies had before send_message, "your final answer is posted back into this thread".
 */
export const CHANNEL_COPY_LIKE = "[#% · post % from % · %posted back into this thread]%";

export class Channels {
  constructor(readonly store: Store, readonly host: Host, readonly threads: Threads, readonly events: ChannelEvents, private readonly log: (line: string) => void = () => {}) {}

  /** Re-awaits deliveries a restart left open. */
  resume(): void {
    for (const row of this.store.channels) {
      for (const post of this.store.postsOf(row.id)) {
        for (const delivery of post.deliveries) {
          if ((delivery.state === "queued" || delivery.state === "delivered" || delivery.state === "read") && delivery.submission !== undefined) void this.awaitAnswer(row, post, delivery);
        }
      }
    }
  }

  row(id: string): ChannelRow | undefined {
    return this.store.channels.find(c => c.id === id || c.name === id);
  }

  list(): Channel[] {
    return this.store.channels.filter(c => !c.archived).map(c => this.view(c));
  }

  view(row: ChannelRow): Channel {
    const posts = this.store.postsOf(row.id);
    return {
      id: row.id, name: row.name, purpose: row.purpose, ...(row.homeChat ? { homeChat: row.homeChat } : {}), createdAt: row.createdAt, archived: row.archived,
      members: this.members(row), lastSeq: posts.at(-1)?.seq ?? 0,
    };
  }

  members(row: ChannelRow): Member[] {
    return row.members.map(m => {
      const principal = this.threads.principal(m.principal);
      const agent = m.principal === "owner" ? undefined : this.threads.agent(m.principal);
      return { principal, role: m.role, wakeOn: m.wakeOn, ...(agent ? { status: agent.status } : {}) };
    });
  }

  memberChannels(agent: AgentId): string[] {
    const key = this.threads.conversationOf(agent);
    return this.store.channels.filter(c => !c.archived && c.members.some(m => m.principal === key)).map(c => c.id);
  }

  summaries(): ConversationSummary[] {
    return this.store.channels.map(row => {
      const posts = this.store.postsOf(row.id);
      const mark = this.store.state.reads[row.id];
      const last = posts.at(-1);
      const unseen = posts.filter(p => p.seq > (mark?.seq ?? 0) && p.author !== "owner");
      const working = row.members.flatMap(m => {
        const agent = m.principal === "owner" ? undefined : this.threads.agent(m.principal);
        return agent?.status === "working" ? [{ id: agent.id, name: agent.name }] : [];
      });
      return {
        id: row.id, kind: "channel" as const, name: row.name, status: working.length ? "working" as const : "idle" as const, archived: row.archived,
        lastActivityAt: last?.at ?? row.createdAt, preview: last ? `${this.threads.principal(last.author).name}: ${last.text}`.slice(0, 200) : row.purpose,
        unread: unseen.filter(p => p.mentions.includes("owner")).length, hasNew: unseen.length > 0, working,
      };
    });
  }

  create(input: ChannelInput): Channel {
    const name = input.name.trim().replace(/^#/, "").toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
    if (!name) throw new Error("A channel needs a name.");
    if (this.store.channels.some(c => c.name === name && !c.archived)) throw new Error(`#${name} already exists.`);
    const now = Date.now();
    const row: ChannelRow = {
      id: `ch_${randomUUID().slice(0, 8)}`, name, purpose: input.purpose ?? "", ...(input.homeChat ? { homeChat: input.homeChat } : {}), createdAt: now, archived: false,
      members: [{ principal: "owner", role: "owner", wakeOn: "all", addedAt: now }, ...(input.members ?? []).map(id => ({ principal: this.threads.conversationOf(id), role: "member" as const, wakeOn: "mention" as const, addedAt: now }))],
    };
    this.store.channels.push(row);
    this.store.saveChannels();
    this.changed(row);
    return this.view(row);
  }

  update(id: string, patch: { name?: string; purpose?: string; archived?: boolean; homeChat?: string | null }): Channel {
    const row = this.require(id);
    if (patch.name !== undefined) row.name = patch.name.trim().replace(/^#/, "").toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
    if (patch.purpose !== undefined) row.purpose = patch.purpose;
    if (patch.archived !== undefined) row.archived = patch.archived;
    if (patch.homeChat === null) delete row.homeChat;
    else if (patch.homeChat !== undefined) row.homeChat = patch.homeChat;
    this.store.saveChannels();
    this.changed(row);
    return this.view(row);
  }

  addMembers(id: string, agents: AgentId[], wakeOn: "mention" | "all" | "none" = "mention"): Channel {
    const row = this.require(id);
    for (const given of agents) {
      if (!this.threads.agent(given)) throw new Error(`No agent ${given}.`);
      const agent = this.threads.conversationOf(given);
      if (!row.members.some(m => m.principal === agent)) row.members.push({ principal: agent, role: "member", wakeOn, addedAt: Date.now() });
    }
    this.store.saveChannels();
    this.changed(row);
    return this.view(row);
  }

  removeMember(id: string, agent: AgentId): Channel {
    const row = this.require(id);
    const key = this.threads.conversationOf(agent);
    row.members = row.members.filter(m => m.principal !== key || m.principal === "owner");
    this.store.saveChannels();
    this.changed(row);
    return this.view(row);
  }

  private require(id: string): ChannelRow {
    const row = this.row(id);
    if (!row) throw new Error(`No channel ${id}.`);
    return row;
  }

  private changed(row: ChannelRow): void {
    this.events.channel(this.view(row));
    this.events.conversations(this.summaries().filter(s => s.id === row.id));
  }

  // Posts and items

  item(post: Post, all?: Post[]): Item {
    const replies = post.threadRoot ? [] : (all ?? this.store.postsOf(post.channel)).filter(p => p.threadRoot === post.id);
    const authors = [...new Set(replies.map(r => r.author))].slice(0, 3).map(a => this.threads.principal(a));
    return {
      kind: "message", id: post.id, at: post.at, author: this.threads.principal(post.author), text: post.text, images: post.images, mentions: post.mentions, seq: post.seq,
      ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}), ...(post.author === "owner" && post.requestId ? { requestId: post.requestId } : {}),
      ...(replies.length ? { thread: { replies: replies.length, lastAt: replies.at(-1)!.at, authors } } : {}),
      deliveries: post.deliveries.map(publicDelivery),
    };
  }

  /** A channel's root posts, newest page last; `before` and `after` are post ids. */
  timeline(id: string, opts: { before?: string; after?: string; around?: string; limit?: number }): TimelinePage {
    const row = this.require(id);
    const all = this.store.postsOf(row.id);
    const roots = all.filter(p => !p.threadRoot);
    const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 200);
    let start: number;
    let end: number;
    let focus: string | undefined;
    if (opts.around) {
      const target = all.find(p => p.id === opts.around);
      focus = target?.threadRoot ?? target?.id;
      const at = Math.max(0, roots.findIndex(p => p.id === focus));
      start = Math.max(0, at - Math.ceil(limit / 2));
      end = Math.min(roots.length, start + limit);
    } else if (opts.after) {
      const at = roots.findIndex(p => p.id === opts.after);
      start = at + 1;
      end = Math.min(roots.length, start + limit);
    } else {
      const at = opts.before ? roots.findIndex(p => p.id === opts.before) : roots.length;
      end = at < 0 ? roots.length : at;
      start = Math.max(0, end - limit);
    }
    const items = roots.slice(start, end).map(p => this.item(p, all));
    return { items, ...(start > 0 ? { older: roots[start]!.id } : {}), ...(end < roots.length ? { newer: roots[end - 1]!.id } : {}), ...(focus ? { focus } : {}) };
  }

  /** A Buzz-style thread: the root post and every reply, oldest first. */
  replies(id: string, root: string): { root: Item; items: Item[] } {
    const row = this.require(id);
    const all = this.store.postsOf(row.id);
    const rootPost = all.find(p => p.id === root);
    if (!rootPost) throw new Error(`No post ${root} in #${row.name}.`);
    return { root: this.item(rootPost, all), items: all.filter(p => p.threadRoot === root).map(p => this.item(p, all)) };
  }

  /**
   * Writes a post and answers once it is on disk and on every watching page; each mention is routed behind it, and a delivery that
   * cannot reach its agent reads `failed` on the post. The owner's posts carry hops 0.
   */
  async post(id: string, author: "owner" | AgentId, request: SendRequest & { hops?: number; images?: never }, images: ImageRef[] = []): Promise<{ item: Item; deliveries: Delivery[] }> {
    const row = this.require(id);
    const posts = this.store.postsOf(row.id);
    const repeat = posts.find(p => p.requestId === request.requestId && p.author === author);
    if (repeat) return { item: this.item(repeat), deliveries: repeat.deliveries.map(publicDelivery) };
    if (request.threadRoot && !posts.some(p => p.id === request.threadRoot && !p.threadRoot)) throw new Error(`No thread ${request.threadRoot} in #${row.name}.`);
    const mentions = [...new Set((request.mentions ?? []).map(m => this.threads.conversationOf(m)))].filter(m => m !== author);
    for (const target of mentions) {
      if (target === "owner") continue;
      if (!row.members.some(m => m.principal === target)) {
        throw new Error(`${this.threads.principal(target).name} is not in #${row.name}. Add it to the channel first.`);
      }
    }
    const seq = (posts.at(-1)?.seq ?? 0) + 1;
    const post: Post = {
      id: `p${seq}`, seq, channel: row.id, author, text: request.text, images, mentions, ...(request.threadRoot ? { threadRoot: request.threadRoot } : {}),
      at: Date.now(), hops: author === "owner" ? 0 : request.hops ?? 1, requestId: request.requestId, deliveries: [],
    };
    this.store.appendPost(post);
    if (author === "owner") this.store.state.reads[row.id] = { at: post.at, seq };
    const targets = mentions.filter(m => m !== "owner");
    for (const member of row.members) {
      if (member.wakeOn === "all" && member.principal !== "owner" && member.principal !== author && !post.threadRoot && !targets.includes(member.principal)) targets.push(member.principal);
    }
    for (const target of targets) {
      const { thread, conversation } = parseConversationId(target);
      const delivery: StoredDelivery = { target, name: this.threads.principal(target).name, state: "queued", at: Date.now(), thread, conversation };
      this.store.setDelivery(post, delivery);
    }
    this.emitPost(row, post);
    for (const delivery of post.deliveries) void this.deliver(row, post, delivery).catch(error => this.log(`delivery ${post.id} to ${delivery.target} failed: ${String(error)}`));
    return { item: this.item(post), deliveries: post.deliveries.map(publicDelivery) };
  }

  private emitPost(row: ChannelRow, post: Post): void {
    const all = this.store.postsOf(row.id);
    const items = [this.item(post, all)];
    if (post.threadRoot) {
      const root = all.find(p => p.id === post.threadRoot);
      if (root) items.push(this.item(root, all));
    }
    this.events.items(row.id, items);
    this.events.conversations(this.summaries().filter(s => s.id === row.id));
  }

  private setState(row: ChannelRow, post: Post, delivery: StoredDelivery, state: DeliveryState, extra: Partial<StoredDelivery> = {}): void {
    Object.assign(delivery, { state, at: Date.now(), ...extra });
    this.store.setDelivery(post, delivery);
    this.emitPost(row, post);
  }

  /** The text the target reads: one header line, the post, and the last posts of its thread. */
  envelope(row: ChannelRow, post: Post, author: Principal): string {
    const all = this.store.postsOf(row.id);
    const rootId = post.threadRoot ?? post.id;
    const thread = all.filter(p => (p.id === rootId || p.threadRoot === rootId) && p.id !== post.id).slice(-CONTEXT_POSTS);
    const lines = [
      `[#${row.name} · post ${post.seq} from ${author.name}${author.kind === "owner" ? " (owner)" : ""} · ${ENVELOPE_TAIL}]`,
      "",
      post.text,
    ];
    if (thread.length) {
      lines.push("", "(thread so far)");
      for (const p of thread) lines.push(`${p.seq} ${this.threads.principal(p.author).name}: ${p.text.slice(0, CONTEXT_CLIP)}`);
    }
    return lines.join("\n");
  }

  private async deliver(row: ChannelRow, post: Post, delivery: StoredDelivery): Promise<void> {
    if (post.hops >= MAX_HOPS) {
      this.setState(row, post, delivery, "stopped", { error: `Stopped after ${MAX_HOPS} agent-to-agent hops with no post from you.` });
      return;
    }
    try {
      const author = this.threads.principal(post.author);
      const submitted = await this.host.submit(delivery.thread, {
        ...(delivery.conversation === 1 ? {} : { conversation: delivery.conversation }),
        text: this.envelope(row, post, author),
        requestId: `channel:${row.id}:${post.id}:${delivery.target}`,
        whenBusy: "followUp",
        entry: { kind: "agent.message", data: { from: post.author, via: `#${row.name}` } },
        // The owner's mention starts at once, as his own sends do; an agent's mention waits its place (channels.md 4.2).
        ...(post.author === "owner" ? { ownerTurn: true } : {}),
      });
      const place = waitingPlace(submitted.ticket?.place);
      this.setState(row, post, delivery, place?.state === "queued" ? "queued" : "delivered", { submission: submitted.submission, ...(place ? { queue: place } : {}) });
      this.events.queue(delivery.target, submitted.ticket?.place ?? null, next => {
        if (delivery.state !== "queued" && delivery.state !== "delivered") return;
        delete delivery.queue;
        this.setState(row, post, delivery, next?.state === "queued" ? "queued" : "delivered", next ? { queue: next } : {});
      });
      void this.awaitAnswer(row, post, delivery);
    } catch (error) {
      this.setState(row, post, delivery, "failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async awaitAnswer(row: ChannelRow, post: Post, delivery: StoredDelivery): Promise<void> {
    try {
      const settled = await this.host.wait(delivery.thread, delivery.submission!);
      const replies = await this.answersOf(row, delivery, settled);
      if (!replies.length) {
        delete delivery.queue;
        this.setState(row, post, delivery, "no_reply");
        return;
      }
      let first: string | undefined;
      for (const [index, text] of replies.entries()) {
        // The first post keeps the id an answer had before send_message, so a delivery a restart re-awaits never posts twice.
        const reply = await this.post(row.id, delivery.target, {
          text, requestId: `answer:${post.id}:${delivery.target}${index ? `:${index}` : ""}`, threadRoot: post.threadRoot ?? post.id,
          mentions: this.mentionsIn(row, text, delivery.target), hops: post.hops + 1,
        });
        first ??= reply.item.id;
      }
      delete delivery.queue;
      this.setState(row, post, delivery, "answered", { answerPost: first, answer: first });
    } catch (error) {
      if (/closed the connection|ECONNREFUSED|ENOENT/.test(String(error))) {
        setTimeout(() => void this.awaitAnswer(row, post, delivery), 2000);
        return;
      }
      this.log(`delivery ${post.id} to ${delivery.target} failed: ${String(error)}`);
      this.setState(row, post, delivery, "failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * What the turn a delivery started posts back: each send_message text it sent to this channel, or none. Only a target that has never
   * called send_message posts its answer's text, as before the tool (`Threads.said`).
   */
  private async answersOf(row: ChannelRow, delivery: StoredDelivery, settled: { entry?: number; answer?: number }): Promise<string[]> {
    const said = await this.threads.said(delivery.thread, delivery.conversation, settled);
    return said.filter(m => !m.to || namesChannel(row, m.to)).map(m => m.text);
  }

  /** Members an agent's answer names as `@Name`, so it can hand work on. */
  private mentionsIn(row: ChannelRow, text: string, author: AgentId): AgentId[] {
    const out: AgentId[] = [];
    for (const member of row.members) {
      if (member.principal === author) continue;
      const name = member.principal === "owner" ? "owner" : this.threads.principal(member.principal).name;
      if (text.includes(`@${name}`)) out.push(member.principal);
    }
    return out;
  }

  markRead(id: string, seq?: number): void {
    const row = this.require(id);
    const last = this.store.postsOf(row.id).at(-1)?.seq ?? 0;
    this.store.state.reads[row.id] = { at: Date.now(), seq: seq ?? last };
    this.store.saveState();
    this.events.conversations(this.summaries().filter(s => s.id === row.id));
  }

  /** Every post whose text matches all words, for search. */
  allPosts(): { row: ChannelRow; post: Post }[] {
    return this.store.channels.flatMap(row => this.store.postsOf(row.id).map(post => ({ row, post })));
  }

  static newRequestId(): string {
    return randomUUID();
  }
}

/** Whether a send_message `to` names this channel: `#name`, `name` or its id. */
export function namesChannel(row: ChannelRow, to: string): boolean {
  const name = to.trim().replace(/^#/, "").toLowerCase();
  return name === row.name || name === row.id.toLowerCase();
}

export function publicDelivery(d: StoredDelivery): Delivery {
  return {
    target: d.target, name: d.name, state: d.state, at: d.at, ...(d.answerPost ? { answer: d.answerPost } : {}), ...(d.error ? { error: d.error } : {}),
    ...(d.queue ? { queue: d.queue } : {}),
  };
}

export const OWNER_PRINCIPAL = OWNER;
