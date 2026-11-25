import { runMacPrecheck } from "./mac-reach.ts";

/**
 * The box side of the 5180 parity duty (demo-parity.ts). 5180 and its checkout live on the owner's Mac, so this runs demo-parity.ts from the
 * Mac's sieun-pi checkout over `ssh mac`, or flags `host_away` while Tailscale lists the Mac asleep, as demo-sandbox-box.ts does.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  await runMacPrecheck("scripts/duties/demo-parity.ts", "5180's pin lag and the parity walk are");
}
