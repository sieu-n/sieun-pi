/**
 * d2's orphan reaper on its own timer (deploy/linux/orphan-reaper.timer): it stops the processes whose owning Prime session ended over
 * ENDED_FOR_MS ago, as the daily VPS and dev boxes run does (scripts/duties/vps-boxes.ts). On 11-03 at 11:40Z five box Chrome runners whose Mac
 * jobs had ended 1 to 10.6 h before still held 2.2 GB on us-metal02, because the daily d2 run had last read the box at 22:52Z the day before.
 */
import { loadHosts, selfHost } from "../src/hosts.ts";
import { defaultContext, describe, hostMatcher, liveStopSource, readOrphans, stopGroups } from "../src/orphan-reaper.ts";

const registry = await loadHosts();
const here = selfHost(registry)?.name;
if (here !== "us-metal02") {
  process.stderr.write(`orphan-reap: runs only on us-metal02, the box the VPS and dev boxes duty owns, not on ${here ?? "an unknown host"}\n`);
  process.exit(2);
}
const at = Date.now();
const { rows, reading } = await readOrphans(defaultContext(here, at), hostMatcher(registry.hosts));
for (const group of reading.stop) process.stdout.write(`stop ${describe(group, at, reading.verdicts)}\n`);
for (const group of reading.unknown) process.stdout.write(`unknown ${describe(group, at, reading.verdicts)}; listed, not stopped\n`);
if (reading.stop.length) {
  const stopped = await stopGroups(reading.stop, rows, liveStopSource);
  process.stdout.write(`sent SIGTERM to ${stopped.signalled.length} orphan processes and SIGKILL to the ${stopped.killed.length} still running 10 s later\n`);
}
