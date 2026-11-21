/**
 * Slack's Save for later, for the owner and for agents: each principal keeps its own list of saved room posts, one item per post, in
 * `<data dir>/later/<by>.json`, where `by` is `owner` or an agent id (/home/sieun/work/later-and-unread/contract.md).
 *
 * An item is `open` (Slack's In progress) until its principal checks it off as `done` (Completed), and saving a done post opens it again.
 * Unsaving deletes the item. `remindAt` and `notifiedAt` belong to Remind me (later-due.ts): a new `remindAt` clears `notifiedAt`, so a
 * snoozed reminder fires again. Each write reaches every `onChange` listener, which the app turns into a live `later` event and a re-sent
 * post, and Remind me into a re-armed timer.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Item, LaterItem, LaterList, LaterMark, LaterPatch, LaterRow, LaterState, Ms, Principal } from "../web/src/lib/api/types.ts";
import { isGroupRoom, type AgentStore, type RoomId, type RoomPost, type RoomRow } from "./agent-store.ts";
import { writeJsonLater } from "./disk.ts";
import { readJson } from "./store.ts";

/** A Later request the server refuses: 400 for a bad body or principal, 404 for a post or item that is not there. */
export class LaterError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
  }
}

export interface LaterDeps {
  store: AgentStore;
  dataDir: string;
  /** The post as its room's timeline shows it, for the row's author. */
  item(row: RoomRow, post: RoomPost): Item;
  principal(id: string): Principal;
}

/** What changed: the item after the write, and `removed` when it was unsaved. */
export type LaterChange = { by: string; item: LaterItem; removed?: true };

interface LaterFile { v: 1; items: LaterItem[] }

/** `owner` or an agent id; it names the principal's file, so it may hold no path characters. */
const PRINCIPAL = /^(owner|ag_[\w.-]+)$/;

/** The one item id of a saved post: `<room id>:<post id>`, such as `ch_1a2b3c4d:p12`. */
export const laterId = (room: RoomId, post: string): string => `${room}:${post}`;

function principalOf(by: string): string {
  if (!PRINCIPAL.test(by)) throw new LaterError(400, `${JSON.stringify(by)} names nobody who saves posts; pass owner or an agent id such as ag_vent.`);
  return by;
}

function timeOf(value: unknown, name: string): Ms | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new LaterError(400, `${name} is a time in ms since 1970, such as ${Date.now() + 3_600_000}.`);
  return value;
}

export class Later {
  private readonly dir: string;
  private readonly files = new Map<string, LaterItem[]>();
  private readonly listeners = new Set<(change: LaterChange) => void>();

  constructor(private readonly deps: LaterDeps) {
    this.dir = join(deps.dataDir, "later");
  }

  /** Calls `listener` after each write; returns the call that stops it. */
  onChange(listener: (change: LaterChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every principal with a Later file, such as `owner` and the agents that saved a post. */
  principals(): string[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter(n => n.endsWith(".json")).map(n => n.slice(0, -5));
    } catch {
      names = [];
    }
    return [...new Set([...names.filter(n => PRINCIPAL.test(n)), ...this.files.keys()])];
  }

  /** The principal's items as stored, newest save first. */
  items(by: string): readonly LaterItem[] {
    return this.load(principalOf(by));
  }

  /** The principal's items in `state`, or all, newest first, as rows that show each post. */
  list(by: string, state?: LaterState): LaterList {
    const all = this.load(principalOf(by));
    const open = all.filter(i => i.state === "open").length;
    const shown = state ? all.filter(i => i.state === state) : all;
    const when = (i: LaterItem) => (i.state === "done" ? i.doneAt ?? i.savedAt : i.savedAt);
    return { items: [...shown].sort((a, b) => when(b) - when(a)).map(i => this.row(i)), open, done: all.length - open };
  }

  get(by: string, id: string): LaterItem | undefined {
    return this.load(principalOf(by)).find(i => i.id === id);
  }

  find(by: string, room: RoomId, post: string): LaterItem | undefined {
    return this.get(by, laterId(room, post));
  }

  /** What a post shows its reader `by` about its own save, or undefined when `by` has no open save of it. */
  mark(by: string, room: RoomId, post: string): LaterMark | undefined {
    const item = PRINCIPAL.test(by) ? this.find(by, room, post) : undefined;
    if (item?.state !== "open") return undefined;
    return { saved: true, ...(item.remindAt !== undefined ? { remindAt: item.remindAt } : {}), ...(item.unread ? { unread: true as const } : {}) };
  }

  /**
   * Saves the post for `by`. Saving a saved post keeps its item, opens it again when it was done and takes a new `remindAt`, so a retry or
   * a second click writes one item.
   */
  save(by: string, input: { room?: unknown; post?: unknown; remindAt?: unknown }): LaterItem {
    const who = principalOf(by);
    if (typeof input.room !== "string" || typeof input.post !== "string") throw new LaterError(400, "A save names its post as {room, post}, such as {room: \"ch_1a2b3c4d\", post: \"p12\"}.");
    const { room, post } = input as { room: RoomId; post: string };
    const remindAt = timeOf(input.remindAt, "remindAt");
    if (!this.deps.store.postsOf(room).some(p => p.id === post)) throw new LaterError(404, `No post ${post} in ${room} to save.`);
    const list = this.load(who);
    const old = list.find(i => i.id === laterId(room, post));
    if (old) {
      if (old.state === "open" && (remindAt === undefined || remindAt === old.remindAt)) return old;
      return this.write(who, { ...this.reopened(old), ...(remindAt !== undefined ? { remindAt } : {}) }, remindAt !== undefined);
    }
    return this.write(who, { id: laterId(room, post), by: who, room, post, savedAt: Date.now(), state: "open", ...(remindAt !== undefined ? { remindAt } : {}) }, false);
  }

  /**
   * Mark unread's Later side (keep-unread.ts): the post sits open in the Keep unread stack until the owner handles it, and its reminder at
   * `remindAt` marks its room unread again. A sooner reminder he already set stays; marking a done item unread opens it again.
   */
  keepUnread(by: string, room: RoomId, post: string, remindAt: Ms): LaterItem {
    const who = principalOf(by);
    if (!this.deps.store.postsOf(room).some(p => p.id === post)) throw new LaterError(404, `No post ${post} in ${room} to keep unread.`);
    const old = this.find(who, room, post);
    if (!old) return this.write(who, { id: laterId(room, post), by: who, room, post, savedAt: Date.now(), state: "open", unread: true, remindAt }, false);
    const keepSooner = old.state === "open" && old.remindAt !== undefined && old.remindAt > Date.now() && old.remindAt < remindAt;
    const next: LaterItem = { ...this.reopened(old), unread: true, remindAt: keepSooner ? old.remindAt! : remindAt };
    if (old.state === "open" && old.unread && next.remindAt === old.remindAt) return old;
    return this.write(who, next, next.remindAt !== old.remindAt);
  }

  /** Checks the item off (`done`) or opens it again (`open`), and sets or clears (`null`) its reminder. A patch that changes nothing writes nothing. */
  update(by: string, id: string, patch: LaterPatch & { notifiedAt?: Ms }): LaterItem {
    const who = principalOf(by);
    const old = this.get(who, id);
    if (!old) throw new LaterError(404, `${who} has no saved post ${id}.`);
    if (patch.state !== undefined && patch.state !== "open" && patch.state !== "done") throw new LaterError(400, "A Later state is open or done.");
    const remindAt = patch.remindAt === null ? null : timeOf(patch.remindAt, "remindAt");
    const notifiedAt = timeOf(patch.notifiedAt, "notifiedAt");
    let next: LaterItem = old;
    if (patch.state === "done" && old.state === "open") next = { ...next, state: "done", doneAt: Date.now() };
    if (patch.state === "open" && old.state === "done") next = this.reopened(next);
    let remindChanged = false;
    if (remindAt === null && next.remindAt !== undefined) {
      const { remindAt: _r, notifiedAt: _n, ...rest } = next;
      next = rest;
      remindChanged = true;
    } else if (typeof remindAt === "number" && remindAt !== next.remindAt) {
      next = { ...next, remindAt };
      remindChanged = true;
    }
    if (notifiedAt !== undefined && !remindChanged) next = { ...next, notifiedAt };
    return next === old ? old : this.write(who, next, remindChanged);
  }

  /** Unsaves the item; unsaving one that is gone answers undefined and writes nothing. */
  remove(by: string, id: string): LaterItem | undefined {
    const who = principalOf(by);
    const list = this.load(who);
    const old = list.find(i => i.id === id);
    if (!old) return undefined;
    this.files.set(who, list.filter(i => i !== old));
    this.flush(who, { by: who, item: old, removed: true });
    return old;
  }

  /**
   * Undo of an unsave: puts the item `remove` answered back as it was, with its state, reminder, Keep unread mark and save time, which is
   * its place in the list. It replaces a save of the post made since.
   */
  restore(by: string, id: string, input: Record<string, unknown>): LaterItem {
    const who = principalOf(by);
    const cut = id.indexOf(":");
    const room = id.slice(0, cut) as RoomId;
    const post = id.slice(cut + 1);
    if (cut < 1 || !this.deps.store.postsOf(room).some(p => p.id === post)) throw new LaterError(404, `No post ${id} to put back in Later.`);
    if (input.state !== "open" && input.state !== "done") throw new LaterError(400, "A Later state is open or done.");
    const savedAt = timeOf(input.savedAt, "savedAt");
    if (savedAt === undefined) throw new LaterError(400, "An item put back names its savedAt, the time in ms it was first saved.");
    const doneAt = input.state === "done" ? timeOf(input.doneAt, "doneAt") ?? Date.now() : undefined;
    const remindAt = timeOf(input.remindAt, "remindAt");
    const notifiedAt = remindAt !== undefined ? timeOf(input.notifiedAt, "notifiedAt") : undefined;
    return this.write(who, {
      id: laterId(room, post), by: who, room, post, savedAt, state: input.state,
      ...(doneAt !== undefined ? { doneAt } : {}), ...(remindAt !== undefined ? { remindAt } : {}), ...(notifiedAt !== undefined ? { notifiedAt } : {}),
      ...(input.unread === true ? { unread: true as const } : {}),
    }, false);
  }

  private reopened(item: LaterItem): LaterItem {
    const { doneAt: _d, archivedAt: _a, ...rest } = item;
    return { ...rest, state: "open" };
  }

  /** Stores `item` in place of the one with its id, or at the top; a new reminder time drops the old `notifiedAt`. */
  private write(by: string, item: LaterItem, remindChanged: boolean): LaterItem {
    let next = item;
    if (remindChanged && next.notifiedAt !== undefined) {
      const { notifiedAt: _n, ...rest } = next;
      next = rest;
    }
    const list = this.load(by);
    const at = list.findIndex(i => i.id === next.id);
    this.files.set(by, at < 0 ? [next, ...list] : list.map((i, n) => (n === at ? next : i)));
    this.flush(by, { by, item: next });
    return next;
  }

  private flush(by: string, change: LaterChange): void {
    writeJsonLater(join(this.dir, `${by}.json`), { v: 1, items: this.files.get(by) ?? [] } satisfies LaterFile);
    for (const listener of this.listeners) listener(change);
  }

  private load(by: string): LaterItem[] {
    let list = this.files.get(by);
    if (!list) {
      list = readJson<LaterFile>(join(this.dir, `${by}.json`), { v: 1, items: [] }).items ?? [];
      this.files.set(by, list);
    }
    return list;
  }

  /** The item with what its row shows: the post's author, room, text and time, or `gone` once the post was deleted or its room is gone. */
  private row(item: LaterItem): LaterRow {
    const room = this.deps.store.rooms.rooms.find(r => r.id === item.room);
    const post = room ? this.deps.store.postsOf(room.id).find(p => p.id === item.post) : undefined;
    const roomKind = room?.kind ?? (item.room.startsWith("dm_") ? "dm" : item.room.startsWith("so_") ? "solo" : "channel");
    const roomName = !room ? item.room : !isGroupRoom(room) ? this.deps.principal(room.agent).name : room.kind === "channel" ? `#${room.name}` : room.name;
    const base = { ...item, roomKind, roomName, ...(this.deps.store.isTest(item.room) ? { test: true as const } : {}) };
    if (!room || !post) return { ...base, text: "", at: item.savedAt, images: 0, gone: true };
    const shown = this.deps.item(room, post);
    return {
      ...base, ...("author" in shown ? { author: shown.author } : {}), text: post.text, at: post.at, images: post.images.length, ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}),
      ...(post.deletedAt !== undefined ? { gone: true as const } : {}),
    };
  }
}
