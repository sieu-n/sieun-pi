/**
 * Slack's Save for later, for the owner and for agents: each principal keeps its own list of saved room posts, one item per post, in
 * `<data dir>/later/<by>.json` or chat.sqlite (later-db.ts), where `by` is `owner` or an agent id (/home/sieun/work/later-and-unread/contract.md).
 *
 * An item is `open` (Slack's In progress) until its principal checks it off as `done` (Completed) or puts it away as `archived` (Archived),
 * and saving a done or archived post opens it again. Unsaving deletes the item. The owner's lists leave out posts in walks' test rooms, as
 * every owner list does (agent-store.ts `isTest`), unless a walk asks for them.
 *
 * `memo` is the principal's own plain text about the item, set as it saves the item or by a patch and never empty: a blank memo is no memo.
 *
 * `remindAt` and `notifiedAt` belong to Remind me (later-due.ts): a new `remindAt` clears `notifiedAt`, so a
 * snoozed reminder fires again. Each write reaches every `onChange` listener, which the app turns into a live `later` event and a re-sent
 * post, and Remind me into a re-armed timer.
 */
import { randomUUID } from "node:crypto";
import type { Item, LaterItem, LaterList, LaterMark, LaterPatch, LaterRow, LaterState, Ms, NoteLaterItem, PostLaterItem, Principal } from "../web/src/lib/api/types.ts";
import { isGroupRoom, type AgentStore, type RoomId, type RoomPost, type RoomRow } from "./agent-store.ts";
import { type LaterLists, PRINCIPAL } from "./later-db.ts";

/** A Saved request the server refuses: 400 for a bad body or principal, 404 for a post or item that is not there. */
export class LaterError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
  }
}

export interface LaterDeps {
  store: AgentStore;
  /** Where the lists are kept (later-db.ts). */
  lists: LaterLists;
  /** The post as its room's timeline shows it, for the row's author. */
  item(row: RoomRow, post: RoomPost): Item;
  principal(id: string): Principal;
}

/** What changed: the item after the write, and `removed` when it was unsaved. */
export type LaterChange = { by: string; item: LaterItem; removed?: true };

/** The one item id of a saved post: `<room id>:<post id>`, such as `ch_1a2b3c4d:p12`. */
export const laterId = (room: RoomId, post: string): string => `${room}:${post}`;

const LATER_STATES: readonly unknown[] = ["open", "archived", "done"] satisfies LaterState[];
/** The longest note or memo an item keeps; longer text is cut. */
const TEXT_MAX = 4000;

function principalOf(by: string): string {
  if (!PRINCIPAL.test(by)) throw new LaterError(400, `${JSON.stringify(by)} names nobody who saves posts; pass owner or an agent id such as ag_vent.`);
  return by;
}

function timeOf(value: unknown, name: string): Ms | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new LaterError(400, `${name} is a time in ms since 1970, such as ${Date.now() + 3_600_000}.`);
  return value;
}

/** A memo as a request sends it: its trimmed text, "" for a blank one or `null`, and undefined when the request names none. */
function memoOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  if (typeof value !== "string") throw new LaterError(400, "memo is plain text, such as {memo: \"read before the Thursday call\"}.");
  return value.trim().slice(0, TEXT_MAX);
}

export class Later {
  private readonly files = new Map<string, LaterItem[]>();
  private readonly listeners = new Set<(change: LaterChange) => void>();

  constructor(private readonly deps: LaterDeps) {}

  /** Calls `listener` after each write; returns the call that stops it. */
  onChange(listener: (change: LaterChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The principal's items as stored, newest save first. */
  items(by: string): readonly LaterItem[] {
    return this.load(principalOf(by));
  }

  /** The principal's items in `state`, or all, newest first, as rows that show each post, with each tab's count. */
  list(by: string, state?: LaterState, opts: { test?: boolean } = {}): LaterList {
    const all = this.listed(principalOf(by), opts.test === true);
    const count = (s: LaterState) => all.filter(i => i.state === s).length;
    const shown = state ? all.filter(i => i.state === state) : all;
    const when = (i: LaterItem) => (i.state === "done" ? i.doneAt : i.state === "archived" ? i.archivedAt : undefined) ?? i.savedAt;
    return { items: [...shown].sort((a, b) => when(b) - when(a)).map(i => this.row(i)), open: count("open"), archived: count("archived"), done: count("done") };
  }

  /** The principal's In progress count, as its Later list shows it. */
  openCount(by: string): number {
    return this.listed(principalOf(by), false).filter(i => i.state === "open").length;
  }

  /** The items a list shows: the owner's leave out posts in test rooms unless `test` asks for them. */
  private listed(by: string, test: boolean): LaterItem[] {
    const all = this.load(by);
    return by !== "owner" || test ? all : all.filter(i => i.room === undefined || !this.deps.store.isTest(i.room));
  }

  get(by: string, id: string): LaterItem | undefined {
    return this.load(principalOf(by)).find(i => i.id === id);
  }

  find(by: string, room: RoomId, post: string): PostLaterItem | undefined {
    const item = this.get(by, laterId(room, post));
    return item?.note === undefined ? item : undefined;
  }

  /** What a post shows its reader `by` about its own save, or undefined when `by` has no open save of it. */
  mark(by: string, room: RoomId, post: string): LaterMark | undefined {
    const item = PRINCIPAL.test(by) ? this.find(by, room, post) : undefined;
    if (item?.state !== "open") return undefined;
    return { saved: true, ...(item.remindAt !== undefined ? { remindAt: item.remindAt } : {}), ...(item.unread ? { unread: true as const } : {}) };
  }

  /**
   * Saves the post for `by`. Saving a saved post keeps its item, opens it again when it was done and takes a new `remindAt` and a new
   * memo, so a retry or a second click writes one item. A save with no memo or a blank one keeps the memo the item has.
   */
  save(by: string, input: { room?: unknown; post?: unknown; note?: unknown; remindAt?: unknown; memo?: unknown }): LaterItem {
    if (input.note !== undefined) return this.remind(by, input.note, input.remindAt, input.memo);
    const who = principalOf(by);
    if (typeof input.room !== "string" || typeof input.post !== "string") throw new LaterError(400, "A save names its post as {room, post}, such as {room: \"ch_1a2b3c4d\", post: \"p12\"}.");
    const { room, post } = input as { room: RoomId; post: string };
    const remindAt = timeOf(input.remindAt, "remindAt");
    const memo = memoOf(input.memo) || undefined;
    if (!this.deps.store.postsOf(room).some(p => p.id === post)) throw new LaterError(404, `No post ${post} in ${room} to save.`);
    const list = this.load(who);
    const old = list.find(i => i.id === laterId(room, post));
    if (old) {
      const sameRemind = remindAt === undefined || remindAt === old.remindAt;
      if (old.state === "open" && sameRemind && (memo === undefined || memo === old.memo)) return old;
      const next = { ...this.reopened(old), ...(remindAt !== undefined ? { remindAt } : {}), ...(memo !== undefined ? { memo } : {}) };
      return this.write(who, next, remindAt !== undefined && (old.state !== "open" || !sameRemind));
    }
    return this.write(who, { id: laterId(room, post), by: who, room, post, savedAt: Date.now(), state: "open", ...(remindAt !== undefined ? { remindAt } : {}), ...(memo !== undefined ? { memo } : {}) }, false);
  }

  /**
   * Slack's /remind me, and a saved wiki page: an item of the principal's own text, with no post, due at `remindAt` when it has one. Each
   * call writes a new item.
   */
  remind(by: string, note: unknown, at: unknown, memoText?: unknown): NoteLaterItem {
    const who = principalOf(by);
    if (typeof note !== "string" || !note.trim()) throw new LaterError(400, "A note names its text as note, such as {note: \"call the bank\", remindAt: 1795300000000}.");
    const remindAt = timeOf(at, "remindAt");
    const memo = memoOf(memoText) || undefined;
    const item: NoteLaterItem = {
      id: `note:${randomUUID().slice(0, 8)}`, by: who, note: note.trim().slice(0, TEXT_MAX), savedAt: Date.now(), state: "open",
      ...(remindAt !== undefined ? { remindAt } : {}), ...(memo !== undefined ? { memo } : {}),
    };
    this.write(who, item, false);
    return item;
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

  /**
   * Checks the item off (`done`), puts it away (`archived`) or opens it again (`open`), sets or clears (`null`) its reminder, and sets or
   * clears (`null` or blank) its memo. A patch that changes nothing writes nothing.
   */
  update(by: string, id: string, patch: LaterPatch & { notifiedAt?: Ms }): LaterItem {
    const who = principalOf(by);
    const old = this.get(who, id);
    if (!old) throw new LaterError(404, `${who} has no saved post ${id}.`);
    if (patch.state !== undefined && !LATER_STATES.includes(patch.state)) throw new LaterError(400, "A saved item's state is open, archived or done.");
    const remindAt = patch.remindAt === null ? null : timeOf(patch.remindAt, "remindAt");
    const notifiedAt = timeOf(patch.notifiedAt, "notifiedAt");
    const memo = memoOf(patch.memo);
    let next: LaterItem = old;
    if (patch.state !== undefined && patch.state !== old.state) {
      const rest = this.reopened(old);
      next = patch.state === "done" ? { ...rest, state: "done", doneAt: Date.now() } : patch.state === "archived" ? { ...rest, state: "archived", archivedAt: Date.now() } : rest;
    }
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
    if (memo && memo !== next.memo) next = { ...next, memo };
    else if (memo === "" && next.memo !== undefined) {
      const { memo: _m, ...rest } = next;
      next = rest;
    }
    return next === old ? old : this.write(who, next, remindChanged);
  }

  /** Unsaves the item; unsaving one that is gone answers undefined and writes nothing. */
  remove(by: string, id: string): LaterItem | undefined {
    const who = principalOf(by);
    const list = this.load(who);
    const old = list.find(i => i.id === id);
    if (!old) return undefined;
    const next = list.filter(i => i !== old);
    this.files.set(who, next);
    this.deps.lists.remove(who, next, old.id);
    this.changed({ by: who, item: old, removed: true });
    return old;
  }

  /**
   * Undo of an unsave: puts the item `remove` answered back as it was, with its state, reminder, Keep unread mark, memo and save time, which
   * is its place in the list. It replaces a save of the post made since.
   */
  restore(by: string, id: string, input: Record<string, unknown>): LaterItem {
    const who = principalOf(by);
    const cut = id.indexOf(":");
    const room = id.slice(0, cut) as RoomId;
    const post = id.slice(cut + 1);
    const note = room === "note" ? input.note : undefined;
    if (room === "note" && (typeof note !== "string" || !note.trim())) throw new LaterError(400, "A reminder put back names its text as note.");
    if (room !== "note" && (cut < 1 || !this.deps.store.postsOf(room).some(p => p.id === post))) throw new LaterError(404, `No post ${id} to put back in Saved.`);
    if (input.state !== "open" && input.state !== "archived" && input.state !== "done") throw new LaterError(400, "A saved item's state is open, archived or done.");
    const savedAt = timeOf(input.savedAt, "savedAt");
    if (savedAt === undefined) throw new LaterError(400, "An item put back names its savedAt, the time in ms it was first saved.");
    const doneAt = input.state === "done" ? timeOf(input.doneAt, "doneAt") ?? Date.now() : undefined;
    const archivedAt = input.state === "archived" ? timeOf(input.archivedAt, "archivedAt") ?? Date.now() : undefined;
    const remindAt = timeOf(input.remindAt, "remindAt");
    const notifiedAt = remindAt !== undefined ? timeOf(input.notifiedAt, "notifiedAt") : undefined;
    const memo = memoOf(input.memo) || undefined;
    return this.write(who, {
      ...(typeof note === "string" ? { id, note } : { id: laterId(room, post), room, post }), by: who, savedAt, state: input.state,
      ...(doneAt !== undefined ? { doneAt } : {}), ...(archivedAt !== undefined ? { archivedAt } : {}), ...(remindAt !== undefined ? { remindAt } : {}), ...(notifiedAt !== undefined ? { notifiedAt } : {}),
      ...(input.unread === true ? { unread: true as const } : {}), ...(memo !== undefined ? { memo } : {}),
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
    const kept = at < 0 ? [next, ...list] : list.map((i, n) => (n === at ? next : i));
    this.files.set(by, kept);
    this.deps.lists.put(by, kept, next);
    this.changed({ by, item: next });
    return next;
  }

  private changed(change: LaterChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private load(by: string): LaterItem[] {
    let list = this.files.get(by);
    if (!list) {
      list = this.deps.lists.load(by);
      this.files.set(by, list);
    }
    return list;
  }

  /** The item with what its row shows: the post's author, room, text and time, or `gone` once the post was deleted or its room is gone. */
  private row(item: LaterItem): LaterRow {
    if (item.note !== undefined) return { ...item, author: this.deps.principal(item.by), text: item.note, at: item.savedAt, images: 0 };
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
