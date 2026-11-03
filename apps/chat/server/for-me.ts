/**
 * Each agent's For list, like a person's Slack Activity view (/home/sieun/work/for-agent/contract.md): the room posts the agent is involved
 * in, read from the post logs, and the agent's own completed marks, the only state this file stores. An item is `<room id>/<post id>`.
 *
 * 1. In the agent's DM, every post another principal wrote that is not imported is on the list as `dm`.
 * 2. In a channel or Solo room, a post another principal wrote is on it as `mention` when it names the agent, `member` when one of its
 *    deliveries went to the agent, and `thread` when it replies in a channel thread whose root or an earlier reply the agent wrote.
 * 3. A post the agent wrote is on it as `reaction` once someone else reacted, with the newest such reaction as its activity.
 *
 * `for-me.json` holds `since`, set when the file is first written, and the marks. A mark completes an item until newer activity, such as a
 * new reaction, opens it again. With no mark, an item from before `since` reads as completed, so the backlog does not flood the list.
 */
import { join } from "node:path";
import type { AgentId, ForMeItem, ForMeList, ForMeReason, ForMeStatus, Item, Ms } from "../web/src/lib/api/types.ts";
import { isGroupRoom, type AgentRecord, type AgentStore, type RoomId, type RoomPost, type RoomRow } from "./agent-store.ts";
import { readJson, writeJson } from "./store.ts";

interface Mark { completed: boolean; at: Ms }
interface ForMeFile { v: 1; since: Ms; marks: Record<AgentId, Record<string, Mark>> }

/** A message item, as the room's timeline shows the post: its author (a job's test send reads as the job's) and its reactions. */
type MessageItem = Extract<Item, { kind: "message" }>;

export interface ForMeDeps {
  store: AgentStore;
  dataDir: string;
  /** The post as its room's timeline shows it. */
  item(row: RoomRow, post: RoomPost): Item;
}

/** A messageId `<room id>/<post id>`, such as `ch_1a2b3c4d/p12`, or undefined when it is not one. */
export function parseItemId(id: unknown): { room: RoomId; post: string } | undefined {
  const match = typeof id === "string" ? /^([\w.-]+)\/(p\d+)$/.exec(id.trim()) : null;
  return match ? { room: match[1]!, post: match[2]! } : undefined;
}

/** Why `post` is on `agent`'s list and its activity time, or undefined when it is not on it. `wrote` holds the channel threads the agent posted in. */
function involvement(agent: AgentId, row: RoomRow, post: RoomPost, wrote: Map<string, number>): { reasons: ForMeReason[]; activityAt: Ms } | undefined {
  if (post.author === agent) {
    const others = (post.reactions ?? []).filter(r => r.by !== agent);
    return others.length ? { reasons: ["reaction"], activityAt: Math.max(...others.map(r => r.at)) } : undefined;
  }
  const reasons: ForMeReason[] = [];
  if (row.kind === "dm") {
    if (row.agent === agent && !post.imported) reasons.push("dm");
  } else {
    if (post.mentions?.includes(agent)) reasons.push("mention");
    if (post.deliveries?.some(d => d.target === agent)) reasons.push("member");
    const first = post.threadRoot ? wrote.get(post.threadRoot) : undefined;
    if (first !== undefined && first < post.seq) reasons.push("thread");
  }
  return reasons.length ? { reasons, activityAt: post.at } : undefined;
}

export class ForMe {
  private readonly path: string;
  private file: ForMeFile;

  constructor(private readonly deps: ForMeDeps) {
    this.path = join(deps.dataDir, "for-me.json");
    const read = readJson<ForMeFile | undefined>(this.path, undefined);
    this.file = read ?? { v: 1, since: Date.now(), marks: {} };
    if (!read) this.save();
  }

  /** The agent's items, newest activity first, with the counts of the whole list. */
  list(record: AgentRecord, status: ForMeStatus | "all" = "pending"): ForMeList {
    const items = this.items(record);
    const pending = items.filter(i => i.status === "pending").length;
    return { agent: record.id, items: status === "all" ? items : items.filter(i => i.status === status), pending, completed: items.length - pending };
  }

  pending(record: AgentRecord): number {
    return this.items(record).filter(i => i.status === "pending").length;
  }

  /**
   * Marks the item completed or pending, or answers undefined when it is not on the agent's list. A call that asks for the status the item
   * has writes nothing, so a replay changes nothing.
   */
  mark(record: AgentRecord, id: string, completed: boolean): { item: ForMeItem; pending: number; changed: boolean } | undefined {
    const items = this.items(record);
    const item = items.find(i => i.id === id);
    if (!item) return undefined;
    const pending = items.filter(i => i.status === "pending").length;
    if ((item.status === "completed") === completed) return { item, pending, changed: false };
    const mark: Mark = { completed, at: Math.max(Date.now(), item.activityAt) };
    (this.file.marks[record.id] ??= {})[id] = mark;
    this.save();
    const marked = this.withStatus(item, mark);
    return { item: marked, pending: pending + (completed ? -1 : 1), changed: true };
  }

  /** Every item on the agent's list, newest activity first. */
  items(record: AgentRecord): ForMeItem[] {
    const out: ForMeItem[] = [];
    for (const row of this.deps.store.rooms.rooms) {
      if (row.archived || (row.kind === "dm" && row.id !== record.room)) continue;
      const posts = this.deps.store.postsOf(row.id);
      const wrote = new Map<string, number>();
      if (row.kind === "channel") {
        for (const post of posts) if (post.author === record.id) wrote.set(post.threadRoot ?? post.id, Math.min(wrote.get(post.threadRoot ?? post.id) ?? post.seq, post.seq));
      }
      for (const post of posts) {
        const found = involvement(record.id, row, post, wrote);
        if (found) out.push(this.withStatus(this.view(row, post, found.reasons, found.activityAt), this.file.marks[record.id]?.[`${row.id}/${post.id}`]));
      }
    }
    return out.sort((a, b) => b.activityAt - a.activityAt);
  }

  private view(row: RoomRow, post: RoomPost, reasons: ForMeReason[], activityAt: Ms): ForMeItem {
    const shown = this.deps.item(row, post) as MessageItem;
    return {
      id: `${row.id}/${post.id}`, room: row.id, roomKind: row.kind, roomName: !isGroupRoom(row) ? "DM" : row.kind === "channel" ? `#${row.name}` : row.name,
      post: post.id, ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}), author: shown.author, text: post.text, at: post.at, activityAt, reasons,
      ...(shown.reactions?.length ? { reactions: shown.reactions } : {}), status: "pending",
    };
  }

  private withStatus(item: ForMeItem, mark: Mark | undefined): ForMeItem {
    const { completedAt: _drop, ...rest } = item;
    if (mark) {
      const completed = mark.completed && mark.at >= item.activityAt;
      return { ...rest, status: completed ? "completed" : "pending", ...(completed ? { completedAt: mark.at } : {}) };
    }
    return { ...rest, status: item.activityAt < this.file.since ? "completed" : "pending" };
  }

  private save(): void {
    writeJson(this.path, this.file);
  }
}
