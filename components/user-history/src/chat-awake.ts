import { spawn } from "node:child_process";

/** The Mac may idle-sleep again once no chat and no job of one has worked for this long. */
export const AWAKE_RELEASE_MS = 2 * 60_000;

/**
 * Whether the service should take or drop its idle-sleep hold at a wake: `start` when something works and no hold runs, `stop` when a hold
 * runs and nothing has worked for AWAKE_RELEASE_MS (`lastWorkAt`: the last wake that saw work), else null.
 */
export function awakeAction(input: { working: boolean; holding: boolean; lastWorkAt: number | null; now: number }): "start" | "stop" | null {
  if (input.working) return input.holding ? null : "start";
  return input.holding && (input.lastWorkAt === null || input.now - input.lastWorkAt >= AWAKE_RELEASE_MS) ? "stop" : null;
}

/** A running hold; `exited` fires when the process ends on its own. */
export interface Hold { kill(): void; exited(listener: () => void): void }

/** `caffeinate -i -w <pid>`: no idle sleep while it runs, and it ends with the service process even if the service crashes. Lid-close sleep still happens. */
function caffeinate(pid: number, log: (line: string) => void): Hold {
  const child = spawn("caffeinate", ["-i", "-w", String(pid)], { detached: true, stdio: "ignore" });
  child.unref();
  child.on("error", error => log(`awake: caffeinate: ${error.message}`));
  return { kill: () => { child.kill(); }, exited: listener => { child.once("exit", listener); } };
}

/**
 * The service's macOS idle-sleep assertion: one `caffeinate` child at most, started when a chat or a job of one works and killed once nothing
 * has worked for AWAKE_RELEASE_MS, or at close. A no-op on other platforms.
 */
export class IdleSleepHold {
  private hold: Hold | null = null;
  private lastWorkAt: number | null = null;
  private closed = false;
  private readonly start: () => Hold;
  private readonly now: () => number;
  private readonly enabled: boolean;

  constructor(private readonly log: (line: string) => void = () => {},
    options: { platform?: NodeJS.Platform; now?: () => number; start?: () => Hold } = {}) {
    this.enabled = (options.platform ?? process.platform) === "darwin";
    this.now = options.now ?? Date.now;
    this.start = options.start ?? (() => caffeinate(process.pid, log));
  }

  get holding(): boolean { return this.hold !== null; }

  update(working: boolean): void {
    if (!this.enabled || this.closed) return;
    const now = this.now();
    if (working) this.lastWorkAt = now;
    const action = awakeAction({ working, holding: this.hold !== null, lastWorkAt: this.lastWorkAt, now });
    if (action === "start") {
      const hold = this.start();
      this.hold = hold;
      hold.exited(() => { if (this.hold === hold) this.hold = null; });
      this.log("awake: a chat or a job works; holding idle sleep off");
    } else if (action === "stop") {
      this.release();
      this.log("awake: nothing has worked for 2 min; idle sleep allowed again");
    }
  }

  private release(): void {
    const hold = this.hold;
    this.hold = null;
    hold?.kill();
  }

  close(): void { this.closed = true; this.release(); }
}
