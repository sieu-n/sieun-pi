import type { SessionSummary } from "prime-agent";
import { agentChildren } from "./chat-agents.ts";
import { clockTime } from "./checkin-settings.ts";
import { childName } from "./checkin-steps.ts";
import { JOB_NOTICE_PREFIX } from "./shared/chat-feed.ts";
import type { ChildAgent, IdleEvictionMinutes, SessionRow, ThreadMessage } from "./shared/types.ts";

/**
 * How long a running or queued child may go with no model, tool or progress-note event, in its own session or any child under it, before it
 * stops holding its chat attached. Placeholder of 120 min until the measured limit lands: at 08:17 KST on 10-14, 8 of 9 chat trees never
 * detached because they held running or stale "working" children.
 */
export const CHILD_SILENT_MS = 120 * 60_000;

/** The latest activity time of `child` and every child under it in `children` (by `parentId`); undefined when `child` itself has none. */
function treeActivity(child: ChildAgent, children: readonly ChildAgent[]): number | undefined {
  if (child.lastActivityAt === undefined) return undefined;
  let latest = child.lastActivityAt;
  const seen = new Set([child.id]);
  const below = [child.id];
  for (let parent = below.pop(); parent !== undefined; parent = below.pop()) {
    for (const other of children) {
      if (other.parentId !== parent || seen.has(other.id)) continue;
      seen.add(other.id);
      below.push(other.id);
      if (other.lastActivityAt !== undefined && other.lastActivityAt > latest) latest = other.lastActivityAt;
    }
  }
  return latest;
}

/**
 * The time a running or queued child went silent, when it and every child under it had no activity for CHILD_SILENT_MS; null when it is not
 * silent. A child with no activity time is never silent, since the daemon seeds that time at its admission.
 */
export function silentSince(child: ChildAgent, children: readonly ChildAgent[], now: number): number | null {
  if (child.status !== "running" && child.status !== "queued") return null;
  const at = treeActivity(child, children);
  return at !== undefined && now - at >= CHILD_SILENT_MS ? at : null;
}

/** A chat's children without the silent ones, for the checks that ask whether anything in its tree still runs. */
export const unsilent = (children: readonly ChildAgent[], now: number): ChildAgent[] => children.filter(child => silentSince(child, children, now) === null);

/**
 * Whether a change of a chat's children shows work: a child added, removed or changed that is not silent. A snapshot that repeats the list, or
 * only a silent child's entry, does not, so it leaves the chat's idle time alone.
 */
export function childrenStirred(before: readonly ChildAgent[], after: readonly ChildAgent[], now: number): boolean {
  const was = new Map(before.map(child => [child.id, JSON.stringify(child)] as const));
  const ids = new Set(after.map(child => child.id));
  return after.some(child => was.get(child.id) !== JSON.stringify(child) && silentSince(child, after, now) === null) ||
    before.some(child => !ids.has(child.id) && silentSince(child, before, now) === null);
}

/** The one line a chat gets for a silent child when it detaches; the id and the time it went silent make the line its own key. */
export function silentNotice(child: ChildAgent, since: number, now: number): string {
  return `${JOB_NOTICE_PREFIX}${childName(child)} (${child.id}) is silent since ${clockTime(since)}, ${Math.floor((now - since) / 60_000)} min, so it no longer holds this ` +
    `chat attached. Delete it with rlm.delete_subagent if it is stuck, or steer it with agent_message.send.`;
}
const noticeKey = (child: ChildAgent, since: number): string => `(${child.id}) is silent since ${clockTime(since)},`;

/**
 * When a pinned chat lets go of its worker. `minutes` reads the daemon's own idle time (Settings, Unload idle sessions after); with none a chat
 * never detaches. `held` keeps a chat attached while a duty of it starts or runs; `now` is the hub clock.
 */
export interface IdleDetach { minutes?: () => IdleEvictionMinutes; held?: (id: string) => Promise<boolean>; now?: () => number }

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * The pinned chats the thread hub detached so the daemon can evict their workers, with the hub clock at each detach. A pin is an attached
 * client, and Prime 0.9.8 evicts a worker tree only when no session in it has one and all of it idled for idleEvictionMinutes, so before
 * this no chat worker was ever evicted. Each detach and wake writes one stderr line for the service log.
 */
export class Dormancy {
  private readonly since = new Map<string, number>();
  /** Each silent child told to its chat, with the time it went silent, so no later detach tells the same silent spell again. */
  private readonly toldSilent = new Map<string, number>();
  readonly now: () => number;
  private readonly idleMinutes: () => IdleEvictionMinutes;
  private readonly isHeld: ((id: string) => Promise<boolean>) | undefined;

  constructor(idle: IdleDetach = {}) {
    this.now = idle.now ?? Date.now;
    this.idleMinutes = idle.minutes ?? (() => "off");
    this.isHeld = idle.held;
  }

  has(id: string): boolean { return this.since.has(id); }
  forget(id: string): void { this.since.delete(id); }

  /** The daemon's idle time, or "off" when the settings file cannot be read (logged), so a bad file never detaches a chat. */
  minutes(): IdleEvictionMinutes {
    try { return this.idleMinutes(); }
    catch (error) { process.stderr.write(`rest: idleEvictionMinutes: ${message(error)}\n`); return "off"; }
  }

  /** A duty check that fails counts as held (logged), so an unread duty store never detaches a chat. */
  async held(id: string): Promise<boolean> {
    if (!this.isHeld) return false;
    return this.isHeld(id).catch(error => { process.stderr.write(`rest ${id.slice(0, 8)}: duty check: ${message(error)}\n`); return true; });
  }

  /** Whether a chat idle since `activeAt` reached the daemon's idle time with no duty holding it. */
  async due(id: string, activeAt: number): Promise<boolean> {
    const minutes = this.minutes();
    return minutes !== "off" && this.now() - activeAt >= minutes * 60_000 && !await this.held(id);
  }

  sleep(id: string, idleMs: number, how: "detached" | "left detached"): void {
    this.since.set(id, this.now());
    process.stderr.write(`dormant ${id.slice(0, 8)}: idle ${Math.floor(idleMs / 60_000)} min, ${how}\n`);
  }

  /** Ends the chat's dormancy and logs the trigger; false when it was not dormant. */
  wake(id: string, trigger: string): boolean {
    const since = this.since.get(id);
    if (since === undefined) return false;
    this.since.delete(id);
    process.stderr.write(`wake ${id.slice(0, 8)}: ${trigger}, dormant ${Math.floor((this.now() - since) / 60_000)} min\n`);
    return true;
  }

  /**
   * The lines for the chat's silent children (`silentSince`) it was not told yet, each marked told: one line per child and silent spell. The
   * hub's memory holds what it told, and after a service start the transcript does. A child that works again and later goes silent again is
   * told again.
   */
  silentLines(children: readonly ChildAgent[], messages: readonly ThreadMessage[]): string[] {
    const now = this.now();
    return children.flatMap(child => {
      const since = silentSince(child, children, now);
      if (since === null || this.toldSilent.get(child.id) === since) return [];
      this.toldSilent.set(child.id, since);
      const key = noticeKey(child, since);
      return messages.some(message => "content" in message && JSON.stringify(message.content).includes(key)) ? [] : [silentNotice(child, since, now)];
    });
  }

  /**
   * The dormant chats a catalog update shows at work, or with message activity after the detach while a worker holds them: an agent message
   * or a child's report woke the session with no client attached. An evicted session's row falls back to its file time, so a saved row never counts.
   * A row at work only through silent jobs (`silentSince`) does not count, or a chat detached past its silent child would attach again at once.
   */
  woken(rows: readonly SessionRow[]): string[] {
    const now = this.now();
    return rows.flatMap(row => {
      const since = this.since.get(row.id);
      if (since === undefined) return [];
      const jobs = agentChildren(row.agents ?? []).filter(child => child.status === "running");
      const working = row.status === "running" || (row.working && (jobs.length === 0 || unsilent(jobs, now).length > 0));
      return working || (row.kind === "live" && Date.parse(row.lastActivityAt ?? "") > since) ? [row.id] : [];
    });
  }

  /**
   * A pinned chat with no thread in the hub (a service start, or a daemon restart that closed it) whose session last worked longer ago than
   * the daemon's idle time stays detached, so a restart does not load every idle worker again. The result is that idle time; null means resume it.
   */
  async restedOnDisk(summary: SessionSummary): Promise<number | null> {
    const last = Date.parse(summary.lastActivityAt ?? "");
    if (!Number.isFinite(last) || summary.isSessionActive || summary.activity === "working" || summary.isStreaming || summary.hasRunningRlmChildren) return null;
    return await this.due(summary.sessionId, last) ? this.now() - last : null;
  }
}
