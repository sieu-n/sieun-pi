import { execFile } from "node:child_process";

/**
 * Whether us-metal01 answers over Tailscale, for a page about its public addresses failing from this box. On 2026-11-16 from 07:10:54Z to
 * 07:26:35Z every connect from us-metal02 (155.254.27.166, AS397373) to us-metal01's addresses (AS13768) timed out, while the box served
 * callers in Korea and on AWS and tailscaled reached it only through the derp-17 relay. A relay-only pong is that kind of fault: the box is
 * up and only the path from here fails, so customers are not cut off and nobody on our side can fix it.
 */
export type Metal01Path = { kind: "relay" | "direct"; via: string } | { kind: "none"; detail: string };

export const METAL01 = "us-metal01";

/** What `tailscale ping -c 1 us-metal01` printed, read as the path it took. */
export function metal01PathOf(output: string): Metal01Path {
  const via = /pong from \S+ \(\S+\) via (.+?) in /.exec(output)?.[1];
  if (!via) return { kind: "none", detail: output.trim().split("\n").at(-1) || "no output" };
  return { kind: via.startsWith("DERP") ? "relay" : "direct", via };
}

/** One `tailscale ping -c 1 us-metal01`; null when the CLI is missing, as on a box off the tailnet. */
export function pingMetal01(): Promise<Metal01Path | null> {
  return new Promise(done => execFile("tailscale", ["ping", "-c", "1", METAL01], (error, stdout, stderr) => {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") { done(null); return; }
    done(metal01PathOf(`${stdout}${stderr}` || (error?.message ?? "")));
  }));
}

/** One sentence on what the ping says, for a page whose public probe of us-metal01 failed on the network. */
export function metal01PathText(path: Metal01Path): string {
  if (path.kind === "none") return `${METAL01} gave no Tailscale pong (${path.detail}), so the box or its whole network is down.`;
  if (path.kind === "relay") return `${METAL01} answers over Tailscale only through ${path.via}, so the box is up and the network path from this box to its public addresses fails, which customers on other networks do not see and which comes back by itself (11-16 07:10 to 07:26Z).`;
  return `${METAL01} answers over Tailscale directly via ${path.via}, so its network is up and the fault is the box's ingress (Caddy) or the service behind it.`;
}
