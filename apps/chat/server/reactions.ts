/**
 * Reactions on room posts, as in Slack (shared/reactions.ts). The owner puts on and takes off his own emoji. The chat server puts the wip
 * mark on the post an agent works on and takes it off when the work ends, from the agent's run state, so no agent ever sets it:
 *
 * 1. While the thread that answers the room runs (the agent's comm thread for it, or the work thread of a DM with none), each post delivered
 *    to that thread since it was last seen idle gets the agent's wip mark. After a restart, with no idle time known, only the newest such
 *    post the agent has not answered gets it.
 * 2. When that turn ends, the mark comes off, unless the turn handed work to the agent's work thread: an agent message from the comm thread
 *    among the work thread's entries after the mark's `mark` entry. Then the mark keeps that entry as `work` and stays until the work thread
 *    has answered it and the agent works no more.
 * 3. While the answering thread waits for a model slot, every mark stays as it is, so the gap between the work thread's report and the
 *    comm thread's turn on it shows the mark too.
 *
 * Every mark keeps its state on the post, so a restart picks it up where it was.
 */
import type { AgentId, Principal, Reaction } from "../web/src/lib/api/types.ts";
import { isEmoji, WIP_EMOJI } from "../web/src/lib/api/shared/reactions.ts";
import type { AgentRecord, AgentStore, RoomId, RoomPost, StoredReaction } from "./agent-store.ts";
import type { Agents } from "./agents.ts";
import type { Host } from "./host/types.ts";
import type { Threads } from "./threads.ts";

/** A post's reactions as the page shows them: one row per emoji, in the order each first came, with who put it on. */
export function reactionsOf(principal: (id: string) => Principal, post: RoomPost): { reactions?: Reaction[] } {
  const by = new Map<string, Principal[]>();
  for (const r of post.reactions ?? []) by.set(r.emoji, [...(by.get(r.emoji) ?? []), principal(r.by)]);
  return by.size ? { reactions: [...by].map(([emoji, people]) => ({ emoji, by: people })) } : {};
}

/** The owner's reactions after he puts `emoji` on (`on`) or takes it off, or undefined when nothing changes. */
export function ownerReaction(post: RoomPost, input: { emoji?: unknown; on?: unknown }): StoredReaction[] | undefined {
  const { emoji } = input;
  if (!isEmoji(emoji)) throw new Error("A reaction is one emoji, such as 👍.");
  if (emoji === WIP_EMOJI) throw new Error(`A reaction of ${WIP_EMOJI} is the agents' working mark, which only the chat server sets; pick another emoji.`);
  if (input.on !== undefined && typeof input.on !== "boolean") throw new Error("A reaction's `on` is true or false.");
  const on = input.on ?? true;
  const list = post.reactions ?? [];
  if (list.some(r => r.by === "owner" && r.emoji === emoji) === on) return undefined;
  return on ? [...list, { emoji, by: "owner", at: Date.now() }] : list.filter(r => !(r.by === "owner" && r.emoji === emoji));
}

const wipOf = (post: RoomPost, agent: AgentId): StoredReaction | undefined => post.reactions?.find(r => r.emoji === WIP_EMOJI && r.by === agent);

/** Whether a delivery of `post` to `agent` reached `thread`, and when; a DM delivery from before the split went to the work thread. */
function deliveredAt(post: RoomPost, record: AgentRecord, thread: string): number | undefined {
  const d = post.delivery ?? post.deliveries?.find(x => x.target === record.id);
  if (!d || d.target !== record.id || d.state !== "delivered" || (d.thread ?? record.workThread) !== thread) return undefined;
  return d.at;
}

export interface WipDeps {
  store: AgentStore;
  agents: Agents;
  threads: Threads;
  host: Host;
  /** The group rooms an agent has a comm thread for and that still exist. */
  groupRooms(record: AgentRecord): RoomId[];
  /** Posts whose reactions changed, for the room's watchers. */
  emit(room: RoomId, posts: RoomPost[]): void;
  log(line: string): void;
}

export class WipReactions {
  /** When each answering thread was last seen idle. */
  private readonly idleAt = new Map<string, number>();
  /** The posts that hold any wip mark, per room, found by one read of each room's log. */
  private readonly held = new Map<RoomId, Set<RoomPost>>();
  private readonly inflight = new Set<string>();
  /** The work thread's `updatedAt` at each handed-over mark's last check, so an unchanged thread is not read again. */
  private readonly checked = new Map<string, number>();

  constructor(private readonly deps: WipDeps) {}

  /** After each thread list read: each agent's answering thread in each of its rooms puts marks on or lets them go. */
  poll(): void {
    for (const record of this.deps.agents.list()) {
      for (const room of [record.room, ...this.deps.groupRooms(record)]) this.room(record, room);
    }
  }

  private heldIn(room: RoomId): Set<RoomPost> {
    let set = this.held.get(room);
    if (!set) this.held.set(room, (set = new Set(this.deps.store.postsOf(room).filter(p => p.reactions?.some(r => r.emoji === WIP_EMOJI)))));
    return set;
  }

  private room(record: AgentRecord, room: RoomId): void {
    const thread = room === record.room ? this.deps.agents.roomThread(record) : record.comm?.[room];
    if (!thread) return;
    const status = record.archived ? "idle" : this.deps.threads.statusOfConversation(thread, 1);
    const held = this.heldIn(room);
    // A thread that waits for a model slot, such as for its turn on the work thread's report, keeps its marks as they are.
    if (status === "sleeping") return;
    if (status === "working") {
      for (const post of this.targets(record, room, thread)) {
        this.put(room, post, [...(post.reactions ?? []), { emoji: WIP_EMOJI, by: record.id, at: Date.now() }]);
        if (thread !== record.workThread) void this.markWork(record, room, post);
      }
      return;
    }
    this.idleAt.set(thread, Date.now());
    for (const post of [...held]) {
      const wip = wipOf(post, record.id);
      if (!wip) continue;
      if (wip.work !== undefined) void this.settleWork(record, room, post, wip.work);
      else if (thread === record.workThread || record.archived) this.drop(room, post, record.id);
      else void this.settleTurn(record, room, thread, post);
    }
  }

  /**
   * The posts that get a mark now: each one delivered to the thread since it was last seen idle, or after a restart the newest one delivered
   * there if the agent has not answered it (a later post of its own, in the same channel thread).
   */
  private targets(record: AgentRecord, room: RoomId, thread: string): RoomPost[] {
    const posts = this.deps.store.postsOf(room);
    const since = this.idleAt.get(thread);
    const out: RoomPost[] = [];
    const answered = new Set<string>();
    const key = (p: RoomPost) => (room.startsWith("ch_") ? (p.threadRoot ?? p.id) : "");
    for (let i = posts.length - 1; i >= 0; i--) {
      const post = posts[i]!;
      if (post.author === record.id) answered.add(key(post));
      const at = deliveredAt(post, record, thread);
      if (at === undefined) continue;
      if (since === undefined) {
        if (!answered.has(key(post)) && !wipOf(post, record.id)) out.push(post);
        break;
      }
      if (at < since) break;
      if (!wipOf(post, record.id)) out.push(post);
    }
    return out;
  }

  private put(room: RoomId, post: RoomPost, reactions: StoredReaction[]): void {
    this.deps.store.set(post, { reactions });
    const held = this.heldIn(room);
    if (reactions.some(r => r.emoji === WIP_EMOJI)) held.add(post);
    else held.delete(post);
    this.deps.emit(room, [post]);
  }

  private drop(room: RoomId, post: RoomPost, agent: AgentId): void {
    if (wipOf(post, agent)) this.put(room, post, (post.reactions ?? []).filter(r => !(r.emoji === WIP_EMOJI && r.by === agent)));
  }

  private patch(room: RoomId, post: RoomPost, agent: AgentId, patch: Partial<StoredReaction>): void {
    if (wipOf(post, agent)) this.put(room, post, post.reactions!.map(r => (r.emoji === WIP_EMOJI && r.by === agent ? { ...r, ...patch } : r)));
  }

  /** Runs one async step per mark at a time; a failure leaves the mark for the next poll. */
  private async once(record: AgentRecord, post: RoomPost, step: () => Promise<void>): Promise<void> {
    const key = `${post.room}/${post.id}/${record.id}`;
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    try {
      await step();
    } catch (error) {
      this.deps.log(`reactions: wip of ${record.id} on ${post.room} ${post.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Notes the work thread's newest entry as the mark goes on, so its end can tell whether the turn handed work over. */
  private markWork(record: AgentRecord, room: RoomId, post: RoomPost): Promise<void> {
    return this.once(record, post, async () => {
      const newest = (await this.deps.host.entries(record.workThread, { conversation: 1, limit: 1 })).entries[0]?.id ?? 0;
      if (wipOf(post, record.id)?.mark === undefined) this.patch(room, post, record.id, { mark: newest });
    });
  }

  /** The turn ended: the mark stays with the hand-over's entry when the turn handed work to the work thread, and comes off otherwise. */
  private settleTurn(record: AgentRecord, room: RoomId, thread: string, post: RoomPost): Promise<void> {
    return this.once(record, post, async () => {
      const mark = wipOf(post, record.id)?.mark;
      const entries = mark === undefined ? [] : (await this.deps.host.entries(record.workThread, { conversation: 1, after: mark, limit: 200 })).entries;
      const hand = entries.find(e => e.kind === "agent.message" && (e.data as { from?: unknown } | undefined)?.from === thread);
      const wip = wipOf(post, record.id);
      if (!wip || wip.work !== undefined || this.deps.threads.statusOfConversation(thread, 1) === "working") return;
      if (hand) this.patch(room, post, record.id, { work: hand.id });
      else this.drop(room, post, record.id);
    });
  }

  /** Handed-over work: the mark comes off once the agent works no more and the work thread has answered the hand-over. */
  private settleWork(record: AgentRecord, room: RoomId, post: RoomPost, work: number): Promise<void> {
    const status = this.deps.threads.agent(record.id)?.status;
    if (status === "working" || status === "sleeping") return Promise.resolve();
    const key = `${post.room}/${post.id}/${record.id}`;
    const updatedAt = this.deps.threads.thread(record.workThread)?.updatedAt ?? 0;
    if (this.checked.get(key) === updatedAt) return Promise.resolve();
    return this.once(record, post, async () => {
      const after = (await this.deps.host.entries(record.workThread, { conversation: 1, after: work, limit: 50 })).entries;
      this.checked.set(key, updatedAt);
      if (record.archived || after.some(e => e.kind === "pi.assistant")) {
        this.checked.delete(key);
        this.drop(room, post, record.id);
      }
    });
  }
}
