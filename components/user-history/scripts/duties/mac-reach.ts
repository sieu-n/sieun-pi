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

/**
 * Whether `tailscale ping` output holds a pong. Exit codes do not say: a pong through a DERP relay exits 1 with "direct connection not
 * established" (us-metal02 to dbhost, 10-27), and the Mac reaches the box only through DERP(tok).
 */
export function pongIn(pingOutput: string): boolean {
  return /^pong from /m.test(pingOutput);
}

/**
 * The `host_away` item for a Mac that `statusJson` lists offline at `address`, or lists online while it gave no pong to a `tailscale ping`
 * (`pong` false), naming the numbers it leaves unmeasured (`what`); undefined otherwise.
 */
export function macAwayItem(statusJson: string, address: string, what: string, at: number, pong?: boolean): FlaggedSlice | undefined {
  const peer = macTailnet(statusJson, address);
  if (!peer || (peer.online && pong !== false)) return undefined;
  const state = peer.online ? "listed online on the tailnet but gave no pong to a tailscale ping, a dark wake from sleep"
    : `offline on the tailnet${peer.lastSeen ? ` since ${peer.lastSeen}` : ""}, asleep or shut`;
  return { at, kind: HOST_AWAY, host: MAC_HOST, excerpt: `the Mac (${address}) is ${state}, so ${what} not measured; ` +
    "the duty reruns once Tailscale reads it online" };
}

/**
 * The `host_away` item for a Mac whose ssh failed (exit 255) and that answers no `tailscale ping` either, so it went back to sleep between the
 * Tailscale read and the dial; undefined when it answers, and the ssh failure stays a source error. At 22:18Z on 10-26 the Mac woke for under
 * 2 min (Tailscale handshake 22:18:07Z, LastSeen 22:20:00Z), the runner reran d1 for it, and ssh timed out on the sleeping Mac, so the run read
 * "the precheck failed" and started a duty job that could do nothing; `tailscale ping 100.66.173.18` got "no reply" at 22:20Z.
 */
export async function macSilent(sshHost: string, what: string, at: number): Promise<FlaggedSlice | undefined> {
  const address = (await run("ssh", ["-G", sshHost], { encoding: "utf8" }).then(result => result.stdout, () => "")).match(/^hostname (\S+)$/m)?.[1];
  if (!address) return undefined;
  const answered = await run("tailscale", ["ping", "-c", "3", "--timeout", "3s", address], { encoding: "utf8" })
    .then(result => pongIn(result.stdout), (error: { stdout?: string }) => pongIn(typeof error.stdout === "string" ? error.stdout : ""));
  return answered ? undefined : { at, kind: HOST_AWAY, host: MAC_HOST, excerpt: `the Mac (${address}) read online on the tailnet but answered no ssh ` +
    `and no tailscale ping, asleep again, so ${what} not measured; the duty reruns once Tailscale reads it online` };
}

/**
 * The `host_away` item when Tailscale lists the Mac offline now, or online while it gives no pong to one `tailscale ping`. A status read that
 * fails gives none, so the precheck dials the Mac as before and a failure there is a source error. `tailscale status --json` reads the
 * tailscaled socket and took 0.03 s on us-metal02 on 10-18 (src/host-reach.ts). The ping is there because the sleeping Mac dark-wakes: on
 * 10-26 Tailscale read it back online at 20:02Z, 20:19Z, 20:36Z, 21:29Z and 22:18Z, each time for 10 s to 2 min while its relay did not
 * answer (service.log), and at 22:18:31Z the host-back reruns of frontend bro's d1 and d5 dialed it, timed out on ssh, read "the precheck
 * failed" and started duty jobs that could do nothing. A pong took 0.2 to 0.3 s on 10-27, and no reply takes Tailscale's 5 s ping timeout.
 */
export async function macAway(sshHost: string, what: string, at: number): Promise<FlaggedSlice | undefined> {
  const read = (file: string, args: string[]) => run(file, args, { encoding: "utf8" }).then(result => result.stdout,
    (error: { stdout?: string }) => typeof error.stdout === "string" ? error.stdout : "");
  const address = (await read("ssh", ["-G", sshHost])).match(/^hostname (\S+)$/m)?.[1];
  if (!address) return undefined;
  const status = await read("tailscale", ["status", "--json"]);
  let peer: ReturnType<typeof macTailnet>;
  try { peer = macTailnet(status, address); } catch { return undefined; }
  const pong = peer?.online ? pongIn(await read("tailscale", ["ping", "-c", "1", address])) : undefined;
  return macAwayItem(status, address, what, at, pong);
}
