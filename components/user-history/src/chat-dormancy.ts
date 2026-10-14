import type { SessionSummary } from "prime-agent";
import type { IdleEvictionMinutes, SessionRow } from "./shared/types.ts";

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
   * The dormant chats a catalog update shows at work, or with message activity after the detach while a worker holds them: an agent message
   * or a child's report woke the session with no client attached. An evicted session's row falls back to its file time, so a saved row never counts.
   */
  woken(rows: readonly SessionRow[]): string[] {
    return rows.flatMap(row => {
      const since = this.since.get(row.id);
      return since !== undefined && (row.working || (row.kind === "live" && Date.parse(row.lastActivityAt ?? "") > since)) ? [row.id] : [];
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
