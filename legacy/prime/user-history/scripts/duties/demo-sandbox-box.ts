import { runMacPrecheck } from "./mac-reach.ts";

/**
 * The box side of the Demo sandbox works duty (demo-sandbox.ts). The demo and its walk live on the owner's MacBook Pro, so this runs
 * demo-sandbox.ts from the Mac's sieun-pi checkout over `ssh mac` and passes its output through. It reads Tailscale first: a Mac that is
 * offline gives a `host_away` item and no ssh, so the runner reruns the duty once the Mac is back (`Duties.rerunHostBack`). From 10-24 to
 * 10-27 frontend bro's d1 ran its bare `ssh mac` at 06:25 KST four days in a row, timed out on the sleeping Mac each time, read "the
 * precheck failed" and started a duty job that could do nothing.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  await runMacPrecheck("scripts/duties/demo-sandbox.ts", "the demo walk, page times, restarts and SSR timeouts are");
}
