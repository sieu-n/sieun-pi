import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type FlaggedSlice, HOST_AWAY } from "../../src/shared/chat-duties.ts";

/**
 * Whether the owner's MacBook Pro is on the tailnet, for the duties that read it over `ssh mac` (box-parity.ts, chat-page-mac.ts). The Mac
 * sleeps through most morning slots, so a precheck that finds it offline flags a `host_away` item with its hosts.json name, leaves its numbers
 * unmeasured, and the runner reruns the duty once Tailscale reads it online (`Duties.rerunHostBack` in src/chat-duty-run.ts).
 */

/** The Mac's name in ~/.config/sieun-pi/hosts.json, which the runner reads its Tailscale state by. */
export const MAC_HOST = "mac";

const run = promisify(execFile);

/**
 * The Mac's tailnet state from `tailscale status --json`, matched by the address `ssh -G` gives for the Mac's ssh host. From 10-23 13:20Z to
 * 10-24 09:26Z eleven d2 runs spent the 190 s browser ssh, the 40 s ping and the 10 min reply wait on a Mac that tailscale already listed
 * offline, and each reported two ssh timeouts. Undefined when the address is not a peer.
 */
export function macTailnet(statusJson: string, address: string): { online: boolean; lastSeen?: string } | undefined {
  const status = JSON.parse(statusJson) as { Peer?: Record<string, { TailscaleIPs?: string[]; Online?: boolean; LastSeen?: string }> };
  const peer = Object.values(status.Peer ?? {}).find(item => item.TailscaleIPs?.includes(address));
  return peer && { online: peer.Online === true, ...peer.LastSeen ? { lastSeen: peer.LastSeen } : {} };
}

/** The `host_away` item for a Mac that `statusJson` lists offline at `address`, naming the numbers it leaves unmeasured (`what`); undefined otherwise. */
export function macAwayItem(statusJson: string, address: string, what: string, at: number): FlaggedSlice | undefined {
  const peer = macTailnet(statusJson, address);
  if (!peer || peer.online) return undefined;
  return { at, kind: HOST_AWAY, host: MAC_HOST, excerpt: `the Mac (${address}) is offline on the tailnet${peer.lastSeen ? ` since ${peer.lastSeen}` : ""}, ` +
    `asleep or shut, so ${what} not measured; the duty reruns once Tailscale reads it online` };
}

/**
 * The `host_away` item when Tailscale lists the Mac offline now. A read that fails gives none, so the precheck dials the Mac as before and a
 * failure there is a source error. `tailscale status --json` reads the tailscaled socket and took 0.03 s on us-metal02 on 10-18 (src/host-reach.ts).
 */
export async function macAway(sshHost: string, what: string, at: number): Promise<FlaggedSlice | undefined> {
  const read = (file: string, args: string[]) => run(file, args, { encoding: "utf8" }).then(result => result.stdout, () => "");
  const address = (await read("ssh", ["-G", sshHost])).match(/^hostname (\S+)$/m)?.[1];
  if (!address) return undefined;
  const status = await read("tailscale", ["status", "--json"]);
  try { return macAwayItem(status, address, what, at); } catch { return undefined; }
}
