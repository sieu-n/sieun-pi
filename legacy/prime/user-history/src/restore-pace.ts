import { DaemonAgentConnection } from "prime-agent";
import { afterMove, type StateAnswer } from "./worker-move.ts";

/**
 * Prime SDK 0.9.8 brings an attached session back after a daemon update or shutdown in DaemonAgentConnection's private
 * `restoreConnectionAfterDaemonRestart`: reconnect, list, attach, then a fixed 100 ms pause, until a 120 s (update) or 60 s bound. At the
 * load.3.3 update restart on us-metal02 on 10-28 the chat's attached threads ran it from 10:21:50Z to 10:22:48Z: about 1,400 lists while the
 * old supervisor drained and the new one started, then 418 attaches refused with "Session worker is starting", 46 to 67 for each of 7
 * sessions over 9 to 16 s, one every 0.20 to 0.26 s. A get_state to a starting worker answers once the worker runs (15,987 ms and 2,356 ms
 * for the two opens that waited that way at 10:22:46Z and 10:22:44Z), and the attach after it landed 21 ms later.
 *
 * So inside that loop a refused attach waits on get_state (src/worker-move.ts `afterMove`) and attaches once more, and the pause between
 * rounds grows through RESTORE_PAUSE_MS.
 */
export const RESTORE_PAUSE_MS = [250, 500, 1_000, 2_000] as const;

export const restorePause = (round: number): number => RESTORE_PAUSE_MS[Math.min(round, RESTORE_PAUSE_MS.length - 1)]!;

type Restore = (this: object, options: { retryMs: number }) => Promise<boolean>;
type Attach = (this: object, options?: { recoverable?: boolean }) => Promise<void>;
type StateClient = { request(command: { type: "get_state"; activeSessionId: string }, timeoutMs?: number, options?: { recoverable?: boolean }): Promise<StateAnswer> };
type Originals = { restore: Restore; attach: Attach };
const ORIGINAL = Symbol.for("sieun-pi.restore-pace.original");

/**
 * Paces the restore loop of every connection made from `proto`. Returns the undo, or null when the SDK no longer has the two methods, so a
 * Prime upgrade that renames them is reported instead of failing the start.
 */
export function paceRestores(proto: object = DaemonAgentConnection.prototype): (() => void) | null {
  const slots = proto as Record<string | symbol, unknown>;
  const found = slots[ORIGINAL] as Originals | undefined ?? { restore: slots.restoreConnectionAfterDaemonRestart, attach: slots.attach };
  if (typeof found.restore !== "function" || typeof found.attach !== "function") return null;
  const { restore, attach } = found as Originals;
  const restoring = new WeakMap<object, number>();
  slots[ORIGINAL] = { restore, attach };
  slots.restoreConnectionAfterDaemonRestart = function (this: object, options: { retryMs: number }): Promise<boolean> {
    let round = 0;
    restoring.set(this, (restoring.get(this) ?? 0) + 1);
    return restore.call(this, { ...options, get retryMs() { return restorePause(round++); } }).finally(() => {
      const left = (restoring.get(this) ?? 1) - 1;
      if (left > 0) restoring.set(this, left); else restoring.delete(this);
    });
  };
  slots.attach = function (this: object, options?: { recoverable?: boolean }): Promise<void> {
    if (!restoring.has(this)) return attach.call(this, options);
    const client = Reflect.get(this, "client") as StateClient;
    const getState = () => client.request({ type: "get_state", activeSessionId: Reflect.get(this, "activeSessionId") as string }, undefined, { recoverable: false });
    return afterMove(() => attach.call(this, options), getState);
  };
  return () => {
    slots.restoreConnectionAfterDaemonRestart = restore;
    slots.attach = attach;
    delete slots[ORIGINAL];
  };
}
