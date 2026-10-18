import { findTailscale, type Runner, runCommand } from "./chat-remote.ts";
import { MAX_BACKOFF_MS } from "./outbox.ts";

/**
 * Whether another box is up, read from this box's Tailscale peer entry. On 10-18 the owner's MacBook Pro went offline at about 14:00Z with its
 * lid closed, and the chat service on us-metal02 kept dialing its daemon: each outbox try to about 14 Mac sessions burned a 10 s handshake
 * timeout every 50 s, and the Whole system precheck booked every minute as a daemon fault. Skills and tools reads the same entry (d379e406).
 * Anything that cannot be read counts as online, so callers dial as before and a box that is up but does not answer still reads as a fault.
 */
export type PeerReach = { online: true } | { online: false; lastSeen: string | undefined };

type Peer = { DNSName?: string; TailscaleIPs?: string[]; Online?: boolean; LastSeen?: string };

/** The reach of the peer at `address`, a Tailscale IP or DNS name, in `tailscale status --json` output; online when the output does not say. */
export function peerReach(status: string, address: string): PeerReach {
  let peers: Peer[];
  try { peers = Object.values((JSON.parse(status.slice(Math.max(0, status.indexOf("{")))) as { Peer?: Record<string, Peer> }).Peer ?? {}); }
  catch { return { online: true }; }
  const peer = peers.find(entry => entry.TailscaleIPs?.includes(address) || entry.DNSName?.replace(/\.$/, "") === address.replace(/\.$/, ""));
  return peer?.Online === false ? { online: false, lastSeen: peer.LastSeen } : { online: true };
}

/** How long ago `at` was, in the words a flag uses: "12 min ago", "2h ago", "3 days ago". */
export function seenAgo(now: number, at: string | undefined): string {
  const minutes = Math.round((now - Date.parse(at ?? "")) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return "at an unknown time";
  return minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)} days ago`;
}

/**
 * This box's `tailscale status --json`, or null without the CLI or on a failure. It reads the tailscaled socket and took 0.03 s on us-metal02
 * on 10-18; the 10 s bound is the one tailnetOwner and Skills and tools already give it.
 */
export async function readTailscaleStatus(run: Runner = runCommand): Promise<string | null> {
  const cli = await findTailscale();
  if (!cli) return null;
  const result = await run(cli, ["status", "--json"], 10_000);
  return result.code === 0 ? result.stdout : null;
}

export interface HostReachDeps {
  /** The Tailscale address of a box in hosts.json, undefined for a box it does not list. */
  addressOf: (host: string) => string | undefined;
  /** `tailscale status --json`, null when it did not read. */
  status?: () => Promise<string | null>;
  log: (line: string) => void;
  now?: () => number;
}

/**
 * The chat service's view of which boxes are offline. It writes one line when a box goes offline and one when it is back. A box read offline
 * stays offline for MAX_BACKOFF_MS before the next read, the longest an outbox lane waits between tries, so the lanes held on one box share one
 * read a round; a box read online is read again on each ask.
 */
export class HostReach {
  private readonly down = new Map<string, { since: number; readAt: number; lastSeen: string | undefined }>();
  private reading: Promise<string | null> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: HostReachDeps) { this.now = deps.now ?? Date.now; }

  async reach(host: string): Promise<PeerReach> {
    const address = this.deps.addressOf(host);
    if (!address) return { online: true };
    const known = this.down.get(host);
    if (known && this.now() - known.readAt < MAX_BACKOFF_MS) return { online: false, lastSeen: known.lastSeen };
    const status = await this.read();
    const reach = status === null ? { online: true } as const : peerReach(status, address);
    const now = this.now();
    if (!reach.online) {
      if (!known) this.deps.log(`hosts: ${host} is offline (Tailscale last seen ${seenAgo(now, reach.lastSeen)}); messages to its sessions wait until it is back`);
      this.down.set(host, { since: known?.since ?? now, readAt: now, lastSeen: reach.lastSeen });
    } else if (known) {
      this.down.delete(host);
      this.deps.log(`hosts: ${host} is back online after ${Math.round((now - known.since) / 60_000)} min; its waiting messages go now`);
    }
    return reach;
  }

  /** One status read at a time, shared by every caller that asks while it runs. */
  private read(): Promise<string | null> {
    if (!this.reading) {
      this.reading = (this.deps.status ?? readTailscaleStatus)().catch(() => null);
      void this.reading.finally(() => { this.reading = null; });
    }
    return this.reading;
  }
}
