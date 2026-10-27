import { runMacPrecheck } from "./mac-reach.ts";

/**
 * The box side of the Staging design rules duty (staging-design-rules.ts). The chat log and the virev-demo tests it reads live on the owner's
 * MacBook Pro, so this runs staging-design-rules.ts from the Mac's sieun-pi checkout over `ssh mac`, as demo-sandbox-box.ts does for d1. A
 * Mac that is away gives a `host_away` item, and the runner reruns the duty once it wakes. On 10-24, 10-25 and 10-26 at 21:35Z frontend
 * bro's d6 ran a bare `ssh mac`, timed out on the sleeping Mac ("ssh: connect to host 100.66.173.18 port 22: Connection timed out") and read
 * error, so it measured nothing those days.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  await runMacPrecheck("scripts/duties/staging-design-rules.ts", "repeated_design_notes_24h and design_rule_test_failures are");
}
