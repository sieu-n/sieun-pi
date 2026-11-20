/**
 * The chat server's own small state in its data dir: thread kinds and read marks. Agents and every room (DMs, channels and Solo rooms) with
 * their post logs are agent-store.ts, duties and check-ins boards.ts. pi-host owns every thread's entries; nothing here copies them. One process writes these files.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readLatest, writeJsonLater } from "./disk.ts";
import type { AgentId, ConversationId, ThinkingLevel } from "../web/src/lib/api/types.ts";

export interface ThreadMeta { kind: "chat" | "job"; parent?: AgentId }
/** The owner's read point in a conversation. `from` is the post he marked unread, which counts as unread whoever wrote it and wherever it sits. */
export interface ReadMark { at: number; seq?: number; from?: string }

/**
 * The read point that reading to `seq`, or to the newest post when absent, leaves; `unreadFrom` puts it just before that post instead and
 * keeps the post as `from`, so it counts as unread even when it is the owner's own or a thread reply.
 */
export function readMark(posts: readonly { id: string; seq: number }[], seq: number | undefined, unreadFrom: string | undefined, room: string): ReadMark {
  if (unreadFrom !== undefined) {
    const post = posts.find(p => p.id === unreadFrom);
    if (!post) throw new Error(`No post ${unreadFrom} in ${room}.`);
    return { at: Date.now(), seq: post.seq - 1, from: post.id };
  }
  const last = posts.at(-1)?.seq ?? 0;
  return { at: Date.now(), seq: Math.min(seq ?? last, last) };
}

export interface StateFile {
  v: 1;
  threads: Record<string, ThreadMeta>;
  reads: Record<ConversationId, ReadMark>;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(tmp, path);
}
export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readLatest(path) ?? "") as T;
  } catch {
    return fallback;
  }
}

export class Store {
  state: StateFile;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.state = readJson<StateFile>(join(dir, "state.json"), { v: 1, threads: {}, reads: {} });
  }

  /** A copy of what pi-host last said, such as the thread list, so pages render while pi-host starts. */
  cache<T>(name: string, fallback: T): T {
    return readJson<T>(join(this.dir, "cache", `${name}.json`), fallback);
  }
  saveCache(name: string, value: unknown): void {
    writeJsonLater(join(this.dir, "cache", `${name}.json`), value);
  }

  /** Counts the saves of state.json; what reads the thread kinds keys its caches on it. */
  version = 0;

  saveState(): void {
    this.version += 1;
    writeJsonLater(join(this.dir, "state.json"), this.state);
  }

  imagePath(name: string): string {
    return join(this.dir, "images", name);
  }
}

export type { ThinkingLevel };
