/**
 * Save for later and Remind me for agents: the server side of pi-host's `save_message`, `remind_me` and `list_saved_messages` tools
 * (packages/pi-host/src/durable/later.ts), over the one Later store keyed by the agent (later.ts).
 *
 * A due reminder goes out through the board's wakes, the ticker that already wakes threads (wakes.ts): while an agent's item is open
 * with a reminder that has not fired, a time wake for the comm thread of the post's room sits among the wakes (wakes-db.ts), and any other
 * state takes it away (`syncWake`). When it fires, `expand` swaps the ticker's `[wake]` line for the post and its thread as they read now, `delivered`
 * stamps the item's notifiedAt, and the room's feed puts the agent's answer in that post's thread (`reminderPost`, group-rooms.ts).
 */
import type { LaterItem, LaterMark, LaterRow, Principal } from "../web/src/lib/api/types.ts";
import type { AgentRecord, RoomId, RoomPost } from "./agent-store.ts";
import { type Later, laterId, LaterError } from "./later.ts";
import { reactionsLine } from "./reactions.ts";
import { parseWake, wakeSession } from "./wakes.ts";
import type { WakeStore } from "./wakes-db.ts";

/** The text a reminder wake carries as its note, which `expand` finds in the ticker's `[wake]` line. */
const NOTE = "remind_me is due on";
const NOTE_LINE = /^\[wake\] .*Your note: remind_me is due on (\S+?)\/(p\d+) for (ag_[\w.-]+)\..*$/;
/** The first line of a reminder as the agent reads it; the feed reads the post from it. */
const REMINDER_LINE = /^\[reminder\] .* remind_me on (\S+?)\/(p\d+)\b/;
/** Hard: the model's context, a long post or thread would fill a wake the way it fills a room read (group-rooms.ts CONTEXT_CLIP). */
const CLIP = 600;
/** Hard: the model's context, the newest replies of a long thread are the ones a check reads. */
const THREAD_POSTS = 12;

export interface AgentLaterDeps {
  later: Later;
  wakes: WakeStore;
  postsOf(room: RoomId): RoomPost[];
  principal(id: string): Principal;
  /** `#name`, `Solo "name"`, or "your DM" for the agent's own DM. */
  label(record: AgentRecord, room: RoomId): string;
  /** The comm thread of `room` for the agent, or undefined when it is not in that room. */
  thread(record: AgentRecord, room: RoomId): string | undefined;
  record(id: string): AgentRecord | undefined;
  log(line: string): void;
  now?: () => number;
}

/** How an agent reads its own save on a post, the way it reads reactions: `[saved · reminder 2026-11-20 05:42Z]`, or "". */
export function laterLine(mark: LaterMark | undefined): string {
  if (!mark?.saved) return "";
  return `[saved${mark.remindAt !== undefined ? ` · reminder ${clock(mark.remindAt)}` : ""}]`;
}

/** The post a reminder in a comm thread's input names, in `room`; a batch of wakes may hold one among other lines. */
export function reminderPost(text: string, room: RoomId): string | undefined {
  for (const line of text.split("\n")) {
    const hit = REMINDER_LINE.exec(line);
    if (hit && hit[1] === room) return hit[2];
  }
  return undefined;
}

const clock = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
const span = (ms: number): string => {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 120 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;
};
const clip = (text: string): string => (text.length > CLIP ? `${text.slice(0, CLIP)}…` : text);
const fired = (item: LaterItem): boolean => item.notifiedAt !== undefined && item.remindAt !== undefined && item.notifiedAt >= item.remindAt;

export class AgentLater {
  constructor(private readonly deps: AgentLaterDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private who(id: string): string {
    const p = this.deps.principal(id);
    return p.kind === "owner" ? "Sieun (owner)" : p.name;
  }

  /** The wake id of an agent's item; one per saved post, so a new time replaces the old wake. */
  private wakeId(item: LaterItem): string {
    return `later-${item.by}-${item.room}-${item.post}`;
  }

  /** Sets the item's wake while its reminder waits, and takes it away otherwise. The owner's reminders are later-due.ts's. */
  syncWake(item: LaterItem, removed = false): void {
    if (item.by === "owner" || item.room === undefined) return;
    const id = this.wakeId(item);
    const record = this.deps.record(item.by);
    const thread = record && this.deps.thread(record, item.room);
    if (removed || item.state !== "open" || item.remindAt === undefined || fired(item) || !thread) {
      void this.deps.wakes.remove(id);
      return;
    }
    const wake = parseWake({
      session: wakeSession(thread, 1), on: { kind: "time", at: item.remindAt }, since: this.now(),
      note: `${NOTE} ${item.room}/${item.post} for ${item.by}.`,
    });
    if (wake) void this.deps.wakes.put(id, wake);
  }

  /** The ticker's text with each reminder's `[wake]` line swapped for the reminder as the agent reads it: the post and its thread now. */
  expand(text: string): string {
    return text.split("\n").map(line => {
      const hit = NOTE_LINE.exec(line);
      const record = hit && this.deps.record(hit[3]!);
      return hit && record ? this.reminder(record, hit[1] as RoomId, hit[2]!) : line;
    }).join("\n");
  }

  /** Stamps notifiedAt on each item whose reminder `text` carried, once the ticker handed it to the thread. */
  delivered(text: string): void {
    for (const line of text.split("\n")) {
      const hit = NOTE_LINE.exec(line);
      if (!hit) continue;
      try {
        const item = this.deps.later.get(hit[3]!, laterId(hit[1] as RoomId, hit[2]!));
        if (item?.remindAt !== undefined) this.deps.later.update(item.by, item.id, { notifiedAt: Math.max(this.now(), item.remindAt) });
      } catch (error) {
        this.deps.log(`later: notifiedAt of ${hit[1]}/${hit[2]} for ${hit[3]}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** What the agent reads when its reminder is due: one line that names it, then the post and, in a channel, its thread as they read now. */
  reminder(record: AgentRecord, room: RoomId, postId: string): string {
    const posts = this.deps.postsOf(room);
    const post = posts.find(p => p.id === postId);
    const where = this.deps.label(record, room);
    const head = `[reminder] It is ${clock(this.now())}, the time you set with remind_me on ${room}/${postId} in ${where}.`;
    if (!post || post.deletedAt !== undefined) return `${head} That post is gone now.`;
    const rootId = post.threadRoot ?? post.id;
    const replies = posts.filter(p => p.threadRoot === rootId && p.deletedAt === undefined);
    const root = posts.find(p => p.id === rootId);
    const line = (p: RoomPost) => {
      const reactions = reactionsLine(id => this.deps.principal(id), p);
      const saved = laterLine(this.deps.later.mark(record.id, room, p.id));
      return `${p.seq} ${this.who(p.author)}: ${clip(p.text)}${p.images.length ? ` [${p.images.length} image${p.images.length > 1 ? "s" : ""} attached]` : ""}${reactions ? ` ${reactions}` : ""}${saved ? ` ${saved}` : ""}`;
    };
    const thread = [...(root && root.deletedAt === undefined ? [root] : []), ...replies];
    if (thread.length <= 1) return `${head} The post now:\n${line(post)}`;
    const shown = thread.length > THREAD_POSTS ? [thread[0]!, ...thread.slice(-(THREAD_POSTS - 1))] : thread;
    const skipped = thread.length - shown.length;
    return `${head} Its thread now, ${replies.length} ${replies.length === 1 ? "reply" : "replies"}${skipped ? `, ${skipped} older ones left out` : ""}:\n` +
      shown.map(line).join("\n");
  }

  /** One item as `list_saved_messages` shows it: a header line, the agent's memo when it wrote one, then the post's text. */
  private itemText(row: LaterRow): string {
    const head = [
      `${row.room}/${row.post} in ${row.roomName}${row.threadRoot ? `, thread ${row.threadRoot}` : ""}`,
      row.author ? `from ${row.author.kind === "owner" ? "Sieun (owner)" : row.author.name}` : "post gone",
      `saved ${clock(row.savedAt)}`,
      ...(row.state === "done" ? [`done ${clock(row.doneAt ?? row.savedAt)}`] : []),
      ...(row.remindAt !== undefined ? [`reminder ${clock(row.remindAt)}${fired(row) ? ", went off" : ""}`] : []),
    ].join(" · ");
    const memo = row.memo !== undefined ? `\nYour memo: ${clip(row.memo)}` : "";
    return row.gone ? `${head}${memo}\n(the post was deleted)` : `${head}${memo}\n${clip(row.text)}`;
  }

  /** `list_saved_messages`: a count line, then one block per item, newest first. */
  listText(record: AgentRecord, state: "open" | "done"): string {
    const list = this.deps.later.list(record.id, state);
    const counts = `${list.open} open, ${list.done} done.`;
    if (!list.items.length) return `${counts} No ${state} saved messages.`;
    return [`${counts} Showing the ${list.items.length} ${state}.`, ...list.items.map(row => this.itemText(row))].join("\n\n");
  }

  /**
   * `save_message` and `remind_me`: sets the agent's item for the post to `state`, its reminder to `remindAt` (null clears it) and, on a
   * save, its memo, and answers the one line the tool returns.
   */
  set(record: AgentRecord, room: RoomId, post: RoomPost, change: { state?: unknown; remindAt?: unknown; memo?: unknown }): string {
    const id = `${room}/${post.id}`;
    const { later } = this.deps;
    const old = later.get(record.id, laterId(room, post.id));
    if (change.state !== undefined && change.state !== "open" && change.state !== "done" && change.state !== "removed") {
      throw new LaterError(400, "A save's state is open, done or removed.");
    }
    if (change.remindAt !== undefined && change.remindAt !== null && (typeof change.remindAt !== "number" || !Number.isSafeInteger(change.remindAt))) {
      throw new LaterError(400, "remindAt is a time in ms since 1970, or null to clear the reminder.");
    }
    if (change.state === "removed") {
      if (!old) return `${id} was not on your saved list.`;
      later.remove(record.id, old.id);
      return `Took ${id} off your saved list${old.remindAt !== undefined && !fired(old) && old.state === "open" ? ", and its reminder with it" : ""}.`;
    }
    if (change.state === "done") {
      if (!old) return `${id} is not saved, so there is nothing to mark done.`;
      later.update(record.id, old.id, { state: "done" });
      return `Marked ${id} done${old.remindAt !== undefined && !fired(old) && old.state === "open" ? "; its reminder will not go off" : ""}. ${this.openCount(record)}`;
    }
    const remindAt = change.remindAt as number | null | undefined;
    let item = later.save(record.id, { room, post: post.id, ...(typeof remindAt === "number" ? { remindAt } : {}), ...(change.memo !== undefined ? { memo: change.memo } : {}) });
    if (remindAt === null && item.remindAt !== undefined) item = later.update(record.id, item.id, { remindAt: null });
    const where = this.deps.label(record, room);
    if (typeof remindAt === "number") {
      return `Reminder set on ${id} for ${clock(remindAt)}, in ${span(remindAt - this.now())}. Then you get a [reminder] in your ${where} thread with the post and its thread.`;
    }
    if (remindAt === null) return `${old?.remindAt !== undefined ? "Cleared the reminder on" : "No reminder was set on"} ${id}; it stays saved.`;
    const memo = item.memo !== undefined && item.memo !== old?.memo ? " with your memo" : "";
    return `${old?.state === "open" && !memo ? "Already saved" : "Saved"} ${id} in ${where}${memo}. ${this.openCount(record)}`;
  }

  private openCount(record: AgentRecord): string {
    const open = this.deps.later.items(record.id).filter(i => i.state === "open").length;
    return `${open} open on your saved list.`;
  }
}
