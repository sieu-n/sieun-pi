/** Background daemon attaches that may run at once per box; a restart pins 10 chats, and at a load of 90 each attach took 16 to 41 s when all ran together. */
export const BACKGROUND_ATTACHES = 2;

type Lane = { active: number; readonly waiting: { key: string; start(): void }[] };

/**
 * Daemon attaches (attach plus the first snapshot). A foreground one (a tab opening a thread, an owner send) starts at once. Background ones
 * (pinned chats coming back, stall checks) wait in order until fewer than `limit` attaches of either kind run on the same box (`host`, the
 * empty string for this one). A foreground request for a key still waiting promotes it, so an open chat never waits behind the others.
 *
 * Each box has its own lane, since the limit guards that box's load. Until 10-18 one lane held them all, and a Mac attach waits up to 5 min
 * for its snapshot (REMOTE_SNAPSHOT_MS): from 12:04Z to 12:22Z the Mac's 01a11ba8 and 01a14ebf held both slots for 300 s at a time while
 * us-metal02's pins, which attach in under 0.3 s, waited 43 to 218 s behind them.
 */
export class AttachQueue {
  private readonly lanes = new Map<string, Lane>();
  constructor(private readonly limit = BACKGROUND_ATTACHES) {}

  async run<T>(key: string, background: boolean, task: () => Promise<T>, host = ""): Promise<T> {
    const lane = this.lane(host);
    if (!background || (lane.active < this.limit && lane.waiting.length === 0)) lane.active++;
    else await new Promise<void>(start => { lane.waiting.push({ key, start }); });
    try { return await task(); }
    finally { lane.active--; this.next(lane); }
  }

  promote(key: string): void {
    for (const lane of this.lanes.values()) {
      const index = lane.waiting.findIndex(entry => entry.key === key);
      if (index < 0) continue;
      const [entry] = lane.waiting.splice(index, 1);
      lane.active++;
      entry!.start();
      return;
    }
  }

  private lane(host: string): Lane {
    let lane = this.lanes.get(host);
    if (!lane) this.lanes.set(host, lane = { active: 0, waiting: [] });
    return lane;
  }

  private next(lane: Lane): void {
    while (lane.active < this.limit && lane.waiting.length) { lane.active++; lane.waiting.shift()!.start(); }
  }
}
