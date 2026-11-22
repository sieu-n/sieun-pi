// The Komodo Stack box-sieun-pi, which runs the sieun-pi services and timers on us-metal02 since 11-21 (auto-sns-agent
// apps/infra/box/compose.sieun-pi.yml). An installer that finds it writes and enables no systemd user unit, because a unit beside the
// container starts a second copy: on 11-21 sieun-pi-wiki.service crash-looped on EADDRINUSE :5176 beside box-sieun-pi-wiki-1.
// deploy/linux/komodo_stack.py is the same check for the Python installers.
import { execFileSync, spawnSync } from "node:child_process";

export const STACK = "box-sieun-pi";

/** Whether docker on this box holds a container of the Stack. */
export function stackRunsHere() {
  const found = spawnSync("docker", ["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${STACK}`], { encoding: "utf8" });
  return found.status === 0 && found.stdout.trim() !== "";
}

/** Stops and disables the old systemd user units, and restarts the Stack's container of a long-running service so it runs the new release. */
export function handOver(units, service) {
  spawnSync("systemctl", ["--user", "disable", "--now", ...units], { stdio: "ignore" });
  if (service) execFileSync("docker", ["restart", `${STACK}-${service}-1`], { stdio: "ignore" });
}

/** Whether the Stack's container of a service is running. */
export function containerRunning(service) {
  const found = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", `${STACK}-${service}-1`], { encoding: "utf8" });
  return found.status === 0 && found.stdout.trim() === "true";
}
