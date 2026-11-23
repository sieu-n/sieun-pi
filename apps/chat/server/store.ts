/**
 * The chat server's own small state in its data dir: thread kinds and read marks. Agents and every room (DMs, channels and Solo rooms) with
 * their post logs are agent-store.ts, duties and check-ins boards.ts. pi-host owns every thread's entries; nothing here copies them. One process writes these files.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { sealedFor } from "./disk.ts";
import { dirname, join } from "node:path";
import { readLatest, writeJsonLater } from "./disk.ts";
import type { AgentId, ConversationId, ConversationPrefs, SavedLayout, ThinkingLevel } from "../web/src/lib/api/types.ts";
import type { SavedSettings } from "../web/src/lib/api/shared/owner-settings.ts";
import { ChatRecords, type Doc } from "./chat-records.ts";
import { STATE } from "./record-kinds.ts";
import type { Kept } from "./kept-json.ts";

export interface ThreadMeta { kind: "chat" | "job"; parent?: AgentId }
/**
 * The owner's read point in a conversation. `from` is the top-level post he marked unread, which counts as unread whoever wrote it, until a
 * read of the room or his handling of the post (keep-unread.ts) clears it.
 */
export interface ReadMark { at: number; seq?: number; from?: string }

/**
 * The read point that reading to `seq`, or to the newest post when absent, leaves; `unreadFrom` puts it just before that post instead and
 * keeps the post as `from`, so it counts as unread even when it is the owner's own. A thread reply marked unread leaves the room's read
 * point where it was, as Slack marks only its thread unread; its Keep unread item in Later stands for the thread.
 */
export function readMark(
  posts: readonly { id: string; seq: number; threadRoot?: string }[], seq: number | undefined, unreadFrom: string | undefined, room: string, current?: ReadMark,
): ReadMark {
  const last = posts.at(-1)?.seq ?? 0;
  if (unreadFrom !== undefined) {
    const post = posts.find(p => p.id === unreadFrom);
    if (!post) throw new Error(`No post ${unreadFrom} in ${room}.`);
    if (post.threadRoot) return current ?? { at: Date.now(), seq: 0 };
    return { at: Date.now(), seq: post.seq - 1, from: post.id };
  }
  return { at: Date.now(), seq: Math.min(seq ?? last, last) };
}

export interface StateFile {
  v: 1;
  threads: Record<string, ThreadMeta>;
  reads: Record<ConversationId, ReadMark>;
  /** Jobs inside a thread the owner archived, with when: pi-host has no archive of its own for a conversation inside a thread. */
  archivedJobs?: Record<ConversationId, number>;
  /** The owner's star, mute and close or leave per room (sidebar-prefs.ts). */
  sidebar?: Record<ConversationId, ConversationPrefs>;
  /** The owner's sidebar sections, placements, sorts and folds, so every browser and the desktop app show the same sidebar. */
  sidebarLayout?: SavedLayout;
  /** The owner's status, notification setting and recent searches, the same in every browser and the desktop app (owner-settings.ts). */
  ownerSettings?: SavedSettings;
}

export function writeJson(path: string, value: unknown): void {
  if (sealedFor(path)) return;
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
  /** state.json, or its rows in chat.sqlite once the server keeps the state kind there (chat-records.ts); `state` is its value. */
  private readonly stateDoc: Doc<StateFile>;

  constructor(readonly dir: string, readonly records: ChatRecords = ChatRecords.standalone(dir)) {
    mkdirSync(dir, { recursive: true });
    this.stateDoc = records.doc(STATE);
  }

  get state(): StateFile {
    return this.stateDoc.value;
  }
  set state(value: StateFile) {
    this.stateDoc.value = value;
  }

  /**
   * The caches as rows of chat.sqlite (kept-json.ts), which the App sets when APPS_CHAT_DB_KINDS names the cache kind; without it each
   * cache is its JSON file under cache/.
   */
  caches?: Kept;

  /** A copy of what pi-host last said, such as the thread list, so pages render while pi-host starts. */
  cache<T>(name: string, fallback: T): T {
    if (this.caches) return (this.caches.read(`cache/${name}.json`) as T | undefined) ?? fallback;
    return readJson<T>(join(this.dir, "cache", `${name}.json`), fallback);
  }
  saveCache(name: string, value: unknown): void {
    if (this.caches) void this.caches.write(`cache/${name}.json`, value);
    else writeJsonLater(join(this.dir, "cache", `${name}.json`), value);
  }

  /** Counts the saves of state.json; what reads the thread kinds keys its caches on it. */
  version = 0;

  saveState(): void {
    this.version += 1;
    this.stateDoc.save();
  }

  imagePath(name: string): string {
    return join(this.dir, "images", name);
  }
}

export type { ThinkingLevel };
