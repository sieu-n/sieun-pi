import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Whether this box was cut off its network: both of its gateways stopped answering in the uplink failover's last round
 * (`metal_uplink_gateway_up`, config/host/uplink-failover in auto-sns-agent, which pings each gateway every 5 s). From 14:27:30Z to 14:42:30Z
 * on 10-27 the provider dropped both of us-metal02's address blocks, its DNS answered EAI_AGAIN and Tailscale lost every DERP server, while its
 * Tailscale still read the Mac online, so every call to the Mac timed out and d7 counted 8 minutes dirty though the chat and both daemons ran.
 */
export const UPLINK_FILE = join(homedir(), "box-ops", "obs", "textfile", "metal-uplink.prom");
/** A reading older than this is no reading: six of the failover's 5 s rounds. */
export const UPLINK_FRESH_MS = 30_000;

/** True when the failover's file, read at `now`, is fresh and holds both gateways down. */
export function uplinkDark(text: string, now: number): boolean {
  const value = (pattern: RegExp): number | undefined => { const found = pattern.exec(text); return found ? Number(found[1]) : undefined; };
  const ranAt = value(/^metal_uplink_run_timestamp_seconds (\S+)$/m);
  if (ranAt === undefined || !(now - ranAt * 1000 <= UPLINK_FRESH_MS)) return false;
  return value(/^metal_uplink_gateway_up\{gateway="primary"\} (\S+)$/m) === 0 && value(/^metal_uplink_gateway_up\{gateway="alt"\} (\S+)$/m) === 0;
}

/** `uplinkDark` of the failover's file; false on a box without one. */
export async function readUplinkDark(now: number, file = UPLINK_FILE): Promise<boolean> {
  return uplinkDark(await readFile(file, "utf8").catch(() => ""), now);
}
