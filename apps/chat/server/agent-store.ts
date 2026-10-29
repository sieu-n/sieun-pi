/**
 * The files that make agents and DM rooms the chat server's own (apps/chat/docs/agent-model.md, phase 2): `agents.json` with each agent and
 * the thread ids that belong to it, `rooms.json` with each room and the feed cursor per agent, and one append-only post log per room under
 * `rooms/`. The server (`agents.ts`, `rooms.ts`) and the migration (`migrate.ts`) both read and write them through this file only.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, ImageRef, Ms } from "../web/src/lib/api/types.ts";
import { readJson, writeJson } from "./store.ts";

export type RoomId = string;

export interface AgentRecord {
  /** `ag_<slug>`. */
  id: AgentId;
  slug: string;
  name: string;
  /** `dm_<slug>`. */
  room: RoomId;
  /** The pi-host thread id of its main work thread, whose root conversation 1 is the agent. */
  workThread: string;
  host: string;
  /** The work thread's cwd when the agent was made. */
  home: string;
  createdAt: Ms;
  archived: boolean;
  /** Set when the migration copied the old thread's history into the room. */
  migrated?: { at: Ms; posts: number; since: Ms };
}

export interface AgentsFile {
  v: 1;
  agents: AgentRecord[];
  /** Every thread id that belongs to an agent: its work thread and each root job thread whose parent is the agent's thread. */
  aliases: Record<string, AgentId>;
}

export interface RoomDelivery {
  target: AgentId;
  state: "sending" | "delivered" | "failed";
  attempts: number;
  at: Ms;
  /** `d:<postId>:<agentId>`, the durable_submit requestId, which pi-host keeps once. */
  requestId: string;
  submission?: number;
  error?: string;
}

export interface RoomPost {
  /** `p<seq>`. */
  id: string;
  seq: number;
  room: RoomId;
  author: "owner" | AgentId;
  text: string;
  images: ImageRef[];
  at: Ms;
  /**
   * The post's one dedup key: the client's requestId for an owner post, `m:<thread>:<toolCallId>` for a speaking call, `i:<thread>:<entry>`
   * for an owner input typed outside the room, and `h:<thread>:...` for migrated history.
   */
  requestId: string;
  why?: string;
  /** The work-thread entry that holds an agent post's call, so "Show work" opens its turn. */
  source?: { thread: string; conversation: number; entry: number };
  /** Jobs the post's turn started, as ConversationIds `<thread>:<n>`. */
  jobs?: string[];
  delivery?: RoomDelivery;
  imported?: boolean;
}

export type PostPatch = Partial<Pick<RoomPost, "delivery" | "jobs" | "text">>;
type LogLine = { t: "post"; post: RoomPost } | { t: "set"; post: string; patch: PostPatch };

export interface RoomRow { id: RoomId; kind: "dm"; agent: AgentId; createdAt: Ms; archived: boolean }

/** Where the feed stands in an agent's work thread, conversation 1. */
export interface FeedCursor {
  /** The last entry id read. */
  entry: number;
  /** Speaking calls seen whose result has not landed yet. */
  open: Record<string, { text: string; entry: number; why?: string }>;
  /** The input that started the current turn, whether a channel post started it, and the turn's newest post. */
  turn?: { input: number; channel: boolean; lastPost?: string };
}

export interface RoomsFile { v: 1; rooms: RoomRow[]; feed: Record<AgentId, FeedCursor> }

export const slugOf = (name: string): string =>
  name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";

/** A slug no agent in `taken` uses: the name's, else with -2, -3 after it. */
export function freeSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugOf(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export class AgentStore {
  agents: AgentsFile;
  rooms: RoomsFile;
  private readonly posts = new Map<RoomId, RoomPost[]>();

  constructor(readonly dir: string) {
    mkdirSync(join(dir, "rooms"), { recursive: true });
    this.agents = readJson<AgentsFile>(join(dir, "agents.json"), { v: 1, agents: [], aliases: {} });
    this.rooms = readJson<RoomsFile>(join(dir, "rooms.json"), { v: 1, rooms: [], feed: {} });
  }

  saveAgents(): void {
    writeJson(join(this.dir, "agents.json"), this.agents);
  }
  saveRooms(): void {
    writeJson(join(this.dir, "rooms.json"), this.rooms);
  }

  /** The agent a thread id or agent id belongs to. */
  agentOf(id: string): AgentRecord | undefined {
    const agentId = id.startsWith("ag_") ? id : this.agents.aliases[id];
    return this.agents.agents.find(a => a.id === agentId);
  }
  agentByRoom(room: RoomId): AgentRecord | undefined {
    return this.agents.agents.find(a => a.room === room);
  }

  postsOf(room: RoomId): RoomPost[] {
    let list = this.posts.get(room);
    if (list) return list;
    list = [];
    const file = this.logFile(room);
    if (existsSync(file)) {
      const byId = new Map<string, RoomPost>();
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let parsed: LogLine;
        try {
          parsed = JSON.parse(line) as LogLine;
        } catch {
          continue;
        }
        if (parsed.t === "post") {
          if (byId.has(parsed.post.id)) continue;
          byId.set(parsed.post.id, parsed.post);
          list.push(parsed.post);
        } else {
          const post = byId.get(parsed.post);
          if (post) Object.assign(post, parsed.patch);
        }
      }
    }
    this.posts.set(room, list);
    return list;
  }

  /** The post with this dedup key, if the room has one. */
  byRequestId(room: RoomId, requestId: string): RoomPost | undefined {
    return this.postsOf(room).find(p => p.requestId === requestId);
  }

  /**
   * Appends a post with the next seq, or answers the post that already has its requestId. Posts keep their seq order; a migrated post
   * keeps its original `at`, so the log is ordered by seq, not by time.
   */
  append(input: Omit<RoomPost, "id" | "seq">): { post: RoomPost; created: boolean } {
    const existing = this.byRequestId(input.room, input.requestId);
    if (existing) return { post: existing, created: false };
    const list = this.postsOf(input.room);
    const seq = (list.at(-1)?.seq ?? 0) + 1;
    const post: RoomPost = { ...input, id: `p${seq}`, seq };
    list.push(post);
    mkdirSync(join(this.dir, "rooms"), { recursive: true });
    appendFileSync(this.logFile(input.room), `${JSON.stringify({ t: "post", post } satisfies LogLine)}\n`);
    return { post, created: true };
  }

  set(post: RoomPost, patch: PostPatch): void {
    Object.assign(post, patch);
    appendFileSync(this.logFile(post.room), `${JSON.stringify({ t: "set", post: post.id, patch } satisfies LogLine)}\n`);
  }

  private logFile(room: RoomId): string {
    return join(this.dir, "rooms", `${room.replace(/[^\w.-]/g, "_")}.jsonl`);
  }
}
