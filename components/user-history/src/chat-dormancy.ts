import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { SessionSummary } from "prime-agent";
import { missing } from "./locked-json.ts";
import { agentChildren } from "./chat-agents.ts";
import { clockTime } from "./checkin-settings.ts";
import { childName } from "./checkin-steps.ts";
import { JOB_NOTICE_PREFIX } from "./shared/chat-feed.ts";
import type { ChildAgent, IdleEvictionMinutes, SessionRow, ThreadMessage } from "./shared/types.ts";

/**
 * How long a running or queued child may go with no model, tool or progress-note event, in its own session or any child under it, before it
 * stops holding its chat attached. Measured 10-14 over 2,542 child sessions of 6 days (334,998 gaps, host sleep left out): in-turn gaps reach
 * 9.2 min at p99.9 and 373 max, and a bash await (CI or deploy wait) 94 min at p99 and 161 min at p99.9, so only 2 legit gaps pass 180 min.
 */
export const CHILD_SILENT_MS = 180 * 60_000;

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
 * Whether a child's new entry shows work: a new status other than a cancel, a reply, new preview, recap or error words, a later activity time or
 * a new activity. An entry that only drops its activity time or activity is the daemon unloading the idle child, and a cancel of a job that
 * ran no turn is the cleanup deleting it.
 */
function childWorked(was: ChildAgent, child: ChildAgent): boolean {
  const said = (key: "answerPreview" | "recap" | "error") => child[key] !== undefined && child[key] !== was[key];
  return (child.status !== was.status && (child.status !== "cancelled" || was.status === "running" || was.status === "queued")) ||
    (child.repliedSinceTask === true && was.repliedSinceTask !== true) || said("answerPreview") || said("recap") || said("error") ||
    (child.lastActivityAt !== undefined && child.lastActivityAt > (was.lastActivityAt ?? -Infinity)) ||
    (child.activity !== undefined && JSON.stringify(child.activity) !== JSON.stringify(was.activity));
}

/**
 * Whether a change of a chat's children shows work: a child added, a child that worked (`childWorked`), or a running or queued child gone, none
 * of them silent. A snapshot that repeats the list, a silent child's entry, an unload or a finished job's delete does not, so it leaves the
 * chat's idle time alone.
 */
export function childrenStirred(before: readonly ChildAgent[], after: readonly ChildAgent[], now: number): boolean {
  const was = new Map(before.map(child => [child.id, child] as const));
  const ids = new Set(after.map(child => child.id));
  return after.some(child => { const old = was.get(child.id); return (old === undefined || childWorked(old, child)) && silentSince(child, after, now) === null; }) ||
    before.some(child => !ids.has(child.id) && (child.status === "running" || child.status === "queued") && silentSince(child, before, now) === null);
}

/** The one line a chat gets for a silent child when it detaches; the id and the time it went silent make the line its own key. */
export function silentNotice(child: ChildAgent, since: number, now: number): string {
  return `${JOB_NOTICE_PREFIX}${childName(child)} (${child.id}) is silent since ${clockTime(since)}, ${Math.floor((now - since) / 60_000)} min, so it no longer holds this ` +
    `chat attached. Delete it with rlm.delete_subagent if it is stuck, or steer it with agent_message.send.`;
}
const noticeKey = (child: ChildAgent, since: number): string => `(${child.id}) is silent since ${clockTime(since)},`;

/**
 * When a pinned chat lets go of its worker. `minutes` reads the daemon's own idle time (Settings, Unload idle sessions after); with none a chat
 * never detaches. `held` keeps a chat attached while a duty of it starts or runs; `now` is the hub clock. `file` keeps each pinned chat's idle
 * clock across a service start; with none every attach after a start counts as activity.
 */
export interface IdleDetach { minutes?: () => IdleEvictionMinutes; held?: (id: string) => Promise<boolean>; now?: () => number; file?: string }

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
  private readonly file: string | undefined;
  /**
   * Each chat's last activity as the service before this start saved it, kept until the chat's first attach. Without it a service start reset
   * every idle clock: 10-14 11:18 to 13:52 KST, 13 releases restarted the service and only 1 of 9 chats detached.
   */
  private readonly before: Map<string, number>;
  private saved = "";

  constructor(idle: IdleDetach = {}) {
    this.now = idle.now ?? Date.now;
    this.idleMinutes = idle.minutes ?? (() => "off");
    this.isHeld = idle.held;
    this.file = idle.file;
    this.before = new Map(this.file ? Object.entries(readClocks(this.file)) : []);
  }

  /** The idle clock of a chat that attaches now: its activity time saved before this service start, once, else now. */
  attachedAt(id: string): number {
    const before = this.before.get(id);
    this.before.delete(id);
    return before === undefined ? this.now() : Math.min(before, this.now());
  }

  /** Writes each chat's idle clock (`activeAt`) when it changed, with the saved times of chats not attached since the start. */
  async save(clocks: Iterable<readonly [string, number]>): Promise<void> {
    if (!this.file) return;
    const text = JSON.stringify(Object.fromEntries([...this.before, ...clocks]));
    if (text === this.saved) return;
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, text, { mode: 0o600 });
    await rename(temp, this.file);
    this.saved = text;
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

  sleep(id: string, idleMs: number, how: "detached" | "left detached" | "detached to recycle its worker"): void {
    this.since.set(id, this.now());
    this.before.delete(id);
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
    return rows.flatMap(row => {
      const since = this.since.get(row.id);
      if (since === undefined) return [];
      return this.atWork(row) || (row.kind === "live" && Date.parse(row.lastActivityAt ?? "") > since) ? [row.id] : [];
    });
  }

  /**
   * Whether a catalog row shows the chat at work: its own turn runs, or the daemon shows a job below it running that is not silent. `rest`
   * asks this too, so a chat the catalog would wake at once is never detached.
   */
  atWork(row: SessionRow): boolean {
    const jobs = agentChildren(row.agents ?? []).filter(child => child.status === "running");
    return row.status === "running" || (row.working && (jobs.length === 0 || unsilent(jobs, this.now()).length > 0));
  }

  /**
   * A pinned chat with no thread in the hub (a service start, or a daemon restart that closed it) that is not at work stays detached until its
   * first need: a send, a duty, or a catalog row that shows it working (`woken`). Its last work is the later of the session's activity and the
   * idle clock saved before the start. Running subagents keep it only when one session below it (`childTimes`, epoch ms at any depth, NaN for
   * none, read only then) was active within CHILD_SILENT_MS, and a duty that holds it keeps it too. The result is that idle time; null means
   * resume it. On 10-18 the starts from 04:22Z to 06:15Z each opened 11 to 49 sessions live in their first 3 min, 13 to 253 s of attach and
   * snapshot in all and up to 49 s for one, and only the chats idle past idleEvictionMinutes stayed detached.
   */
  async restedOnDisk(summary: SessionSummary, childTimes: () => readonly number[]): Promise<number | null> {
    const known = [Date.parse(summary.lastActivityAt ?? ""), this.before.get(summary.sessionId) ?? Number.NaN].filter(Number.isFinite);
    const last = Math.max(...known);
    if (known.length === 0 || summary.isSessionActive || summary.activity === "working" || summary.isStreaming) return null;
    const now = this.now();
    if (summary.hasRunningRlmChildren) {
      const times = childTimes();
      if (times.length === 0 || times.some(at => !(now - at >= CHILD_SILENT_MS))) return null;
    }
    return await this.held(summary.sessionId) ? null : now - last;
  }
}

/** The saved idle clocks; none when the file is missing, or unreadable (logged), so a bad file only costs the old reset. */
function readClocks(file: string): Record<string, number> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
  } catch (error) {
    if (!missing(error)) process.stderr.write(`rest: ${file}: ${message(error)}\n`);
    return {};
  }
}

/**
 * Whether a session event shows work, so it moves a chat's idle clock: a turn, a message of the owner, the model or a tool, a tool or bash
 * run, a compaction or a retry. A state notice does not (a name, thinking level, goal, recap, queue or child update, a progress note), nor a
 * custom message injected outside a turn. On 10-18 '***launch main bro***' did no work from 03:30:01Z to its stop at 04:21Z (its session file
 * holds only a harness_digest message injected at 03:55:30Z), yet the service detached it only at 04:14:03Z, and its worker counted as
 * sleeping from 04:08Z.
 */
export function showsWork(event: { type: string; message?: unknown }): boolean {
  switch (event.type) {
    case "agent_start": case "agent_end": case "turn_start": case "turn_end": case "message_update":
    case "tool_execution_start": case "tool_execution_update": case "tool_execution_end":
    case "compaction_start": case "compaction_end": case "auto_retry_start": case "auto_retry_end":
    case "bash_start": case "bash_output": case "bash_end": case "ipython_sent_agent_message":
      return true;
    case "message_start": case "message_end": {
      const role = typeof event.message === "object" && event.message !== null ? (event.message as { role?: unknown }).role : undefined;
      return role === "user" || role === "assistant" || role === "toolResult" || role === "bashExecution";
    }
    default:
      return false;
  }
}
