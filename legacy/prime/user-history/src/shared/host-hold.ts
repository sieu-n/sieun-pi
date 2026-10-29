/**
 * A step whose job runs on a box that Tailscale reads offline waits for that box, and no job can start, steer or read it until the box is
 * back. From about 10:10Z on 10-23 the owner's MacBook Pro slept off Tailscale and every job of sep launch!! and Railway Breach on it read
 * ended, so the check-in counted 39 and 2 stuck steps and d9 read stuck_steps_all 44 at 12:27Z. Until 10-30 such a step counted as held only
 * while an open For you todo asked the owner to wake the box, so every sleep of the Mac became an owner ask: on 10-30 from about 03:50 KST a
 * check-in added t122 and d9 added t60 on designer bro to ask him to wake it (c178). The hold now reads the box's state alone, and once the
 * box reads online again its steps count by their jobs again.
 */
export interface HostHold {
  /** The box's hosts.json name. */
  host: string;
  /** When Tailscale last saw the box. */
  lastSeen?: string;
}

/** A box that reads offline now, by its hosts.json name, with when Tailscale last saw it. */
export interface AwayHost { name: string; lastSeen?: string }

/** Each offline box's hold, by its hosts.json name. */
export const hostHolds = (away: readonly AwayHost[]): Map<string, HostHold> =>
  new Map(away.map(host => [host.name, { host: host.name, ...host.lastSeen ? { lastSeen: host.lastSeen } : {} }]));

/** "mac, offline on Tailscale since 10:09Z". */
export const holdWords = (hold: HostHold): string =>
  `${hold.host}, offline on Tailscale${hold.lastSeen && Number.isFinite(Date.parse(hold.lastSeen)) ? ` since ${new Date(hold.lastSeen).toISOString().slice(11, 16)}Z` : ""}`;
