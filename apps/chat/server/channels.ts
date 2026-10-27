/**
 * Channels after ~/work/slack-layer-design/channels.md sections 3 and 4. A channel is a named room with members and one post log in the
 * chat server's data dir. A post that @mentions an agent goes to that agent's conversation as an `agent.message` input, and the answer of
 * the turn it starts comes back into the post's thread as the agent's post. Each mention is one delivery with its own state.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentId, Channel, ChannelInput, ConversationSummary, Delivery, DeliveryState, ImageRef, Item, Member, Principal, SendRequest, TimelinePage,
} from "../web/src/lib/api/types.ts";
import type { Host } from "./host/types.ts";
import type { ChannelRow, Post, Store, StoredDelivery } from "./store.ts";
import { OWNER, parseConversationId, type Threads } from "./threads.ts";

/** Hard: money, an agent loop runs paid model turns nobody reads (channels.md 4.3). */
export const MAX_HOPS = 6;
const CONTEXT_POSTS = 5;
const CONTEXT_CLIP = 2048;
const PAGE = 50;

export interface ChannelEvents {
  items(conversation: string, items: Item[]): void;
  channel(channel: Channel): void;
  conversations(changed: ConversationSummary[]): void;
}

export class Channels {
  constructor(readonly store: Store, readonly host: Host, readonly threads: Threads, readonly events: ChannelEvents, private readonly log: (line: string) => void = () => {}) {}

  /** Re-awaits deliveries a restart left open. */
  resume(): void {
    for (const row of this.store.channels) {
      for (const post of this.store.postsOf(row.id)) {
        for (const delivery of post.deliveries) {
          if ((delivery.state === "delivered" || delivery.state === "read") && delivery.submission !== undefined) void this.awaitAnswer(row, post, delivery);
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
    return this.store.channels.filter(c => !c.archived && c.members.some(m => m.principal === agent)).map(c => c.id);
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
      members: [{ principal: "owner", role: "owner", wakeOn: "all", addedAt: now }, ...(input.members ?? []).map(id => ({ principal: id, role: "member" as const, wakeOn: "mention" as const, addedAt: now }))],
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
    for (const agent of agents) {
      if (!this.threads.agent(agent)) throw new Error(`No agent ${agent}.`);
      if (!row.members.some(m => m.principal === agent)) row.members.push({ principal: agent, role: "member", wakeOn, addedAt: Date.now() });
    }
    this.store.saveChannels();
    this.changed(row);
    return this.view(row);
  }

  removeMember(id: string, agent: AgentId): Channel {
    const row = this.require(id);
    row.members = row.members.filter(m => m.principal !== agent || m.principal === "owner");
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
      ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}),
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

  /** Writes a post and routes each mention. The owner's posts carry hops 0. */
  async post(id: string, author: "owner" | AgentId, request: SendRequest & { hops?: number; images?: never }, images: ImageRef[] = []): Promise<{ item: Item; deliveries: Delivery[] }> {
    const row = this.require(id);
    const posts = this.store.postsOf(row.id);
    const repeat = posts.find(p => p.requestId === request.requestId && p.author === author);
    if (repeat) return { item: this.item(repeat), deliveries: repeat.deliveries.map(publicDelivery) };
    if (request.threadRoot && !posts.some(p => p.id === request.threadRoot && !p.threadRoot)) throw new Error(`No thread ${request.threadRoot} in #${row.name}.`);
    const mentions = [...new Set(request.mentions ?? [])].filter(m => m !== author);
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
    await Promise.all(post.deliveries.map(d => this.deliver(row, post, d)));
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
      `[#${row.name} · post ${post.seq} from ${author.name}${author.kind === "owner" ? " (owner)" : ""} · your final answer is posted back into this thread]`,
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
      });
      this.setState(row, post, delivery, "delivered", { submission: submitted.submission });
      void this.awaitAnswer(row, post, delivery);
    } catch (error) {
      this.setState(row, post, delivery, "failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async awaitAnswer(row: ChannelRow, post: Post, delivery: StoredDelivery): Promise<void> {
    try {
      const settled = await this.host.wait(delivery.thread, delivery.submission!);
      const answer = settled.answer === undefined ? "" : await this.answerText(delivery, settled.answer);
      if (!answer.trim()) {
        this.setState(row, post, delivery, "no_reply");
        return;
      }
      const reply = await this.post(row.id, delivery.target, {
        text: answer, requestId: `answer:${post.id}:${delivery.target}`, threadRoot: post.threadRoot ?? post.id,
        mentions: this.mentionsIn(row, answer, delivery.target), hops: post.hops + 1,
      });
      this.setState(row, post, delivery, "answered", { answerPost: reply.item.id, answer: reply.item.id });
    } catch (error) {
      this.log(`delivery ${post.id} to ${delivery.target} failed: ${String(error)}`);
      this.setState(row, post, delivery, "failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async answerText(delivery: StoredDelivery, entryId: number): Promise<string> {
    const got = await this.host.entries(delivery.thread, { conversation: delivery.conversation, before: entryId + 1, limit: 1 });
    const message = got.entries[0]?.model?.[0];
    if (!message || message.role !== "assistant") return "";
    return typeof message.content === "string" ? message.content : message.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n\n");
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

export function publicDelivery(d: StoredDelivery): Delivery {
  return { target: d.target, name: d.name, state: d.state, at: d.at, ...(d.answerPost ? { answer: d.answerPost } : {}), ...(d.error ? { error: d.error } : {}) };
}

export const OWNER_PRINCIPAL = OWNER;
