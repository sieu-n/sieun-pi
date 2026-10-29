/**
 * The chat server's own small state in its data dir: thread kinds, read marks, channels and their post logs. Agents and DM rooms are
 * agent-store.ts, duties and check-ins boards.ts. pi-host owns every thread's entries; nothing here copies them. One process writes these files.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentId, ConversationId, Delivery, ImageRef, ThinkingLevel } from "../web/src/lib/api/types.ts";

export interface ThreadMeta { kind: "chat" | "job"; parent?: AgentId }
export interface ReadMark { at: number; seq?: number }
export interface StateFile {
  v: 1;
  threads: Record<string, ThreadMeta>;
  reads: Record<ConversationId, ReadMark>;
}

export interface ChannelRow {
  id: string; name: string; purpose: string; homeChat?: string; createdAt: number; archived: boolean;
  members: { principal: "owner" | AgentId; role: "owner" | "member"; wakeOn: "mention" | "all" | "none"; addedAt: number }[];
}

/** A delivery as stored: the owner sees `Delivery`, and the router also keeps where it went. */
export interface StoredDelivery extends Delivery { thread: string; conversation: number; submission?: number; answerPost?: string }
export interface Post {
  id: string; seq: number; channel: string; author: "owner" | AgentId; text: string; images: ImageRef[]; mentions: AgentId[];
  threadRoot?: string; at: number; hops: number; requestId?: string; deliveries: StoredDelivery[];
}
type LogLine = { t: "post"; post: Post } | { t: "delivery"; post: string; delivery: StoredDelivery };


export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(tmp, path);
}
export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class Store {
  state: StateFile;
  channels: ChannelRow[];
  private readonly posts = new Map<string, Post[]>();

  constructor(readonly dir: string) {
    mkdirSync(join(dir, "channels"), { recursive: true });
    this.state = readJson<StateFile>(join(dir, "state.json"), { v: 1, threads: {}, reads: {} });
    this.channels = readJson<{ channels: ChannelRow[] }>(join(dir, "channels.json"), { channels: [] }).channels;
  }

  /** A copy of what pi-host last said, such as the thread list, so pages render while pi-host starts. */
  cache<T>(name: string, fallback: T): T {
    return readJson<T>(join(this.dir, "cache", `${name}.json`), fallback);
  }
  saveCache(name: string, value: unknown): void {
    writeJson(join(this.dir, "cache", `${name}.json`), value);
  }

  saveState(): void {
    writeJson(join(this.dir, "state.json"), this.state);
  }
  saveChannels(): void {
    writeJson(join(this.dir, "channels.json"), { channels: this.channels });
  }

  postsOf(channel: string): Post[] {
    let list = this.posts.get(channel);
    if (list) return list;
    list = [];
    const file = join(this.dir, "channels", `${channel}.jsonl`);
    if (existsSync(file)) {
      const byId = new Map<string, Post>();
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let parsed: LogLine;
        try {
          parsed = JSON.parse(line) as LogLine;
        } catch {
          continue;
        }
        if (parsed.t === "post") {
          byId.set(parsed.post.id, parsed.post);
          list.push(parsed.post);
        } else {
          const post = byId.get(parsed.post);
          if (!post) continue;
          const index = post.deliveries.findIndex(d => d.target === parsed.delivery.target);
          if (index >= 0) post.deliveries[index] = parsed.delivery;
          else post.deliveries.push(parsed.delivery);
        }
      }
    }
    this.posts.set(channel, list);
    return list;
  }

  appendPost(post: Post): void {
    this.postsOf(post.channel).push(post);
    appendFileSync(join(this.dir, "channels", `${post.channel}.jsonl`), `${JSON.stringify({ t: "post", post } satisfies LogLine)}\n`);
  }

  setDelivery(post: Post, delivery: StoredDelivery): void {
    const index = post.deliveries.findIndex(d => d.target === delivery.target);
    if (index >= 0) post.deliveries[index] = delivery;
    else post.deliveries.push(delivery);
    appendFileSync(join(this.dir, "channels", `${post.channel}.jsonl`), `${JSON.stringify({ t: "delivery", post: post.id, delivery } satisfies LogLine)}\n`);
  }

  imagePath(name: string): string {
    return join(this.dir, "images", name);
  }
}

export type { ThinkingLevel };
