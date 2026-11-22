// The Komodo Stack box-sieun-pi, which runs the sieun-pi services and jobs on us-metal02 since 11-21 (auto-sns-agent
// apps/infra/box/compose.sieun-pi.yml). No sieun-pi installer writes a systemd user unit on Linux: on 11-21 sieun-pi-wiki.service
// crash-looped on EADDRINUSE :5176 beside box-sieun-pi-wiki-1. deploy/linux/komodo_stack.py is the same helper for the Python installers.
import { execFileSync, spawnSync } from "node:child_process";

export const STACK = "box-sieun-pi";

/** Restarts the Stack's container of a long-running service, so it runs the release the installer just put in place. */
export function restart(service) {
  execFileSync("docker", ["restart", `${STACK}-${service}-1`], { stdio: "ignore" });
}

/** Whether the Stack's container of a service is running. */
export function containerRunning(service) {
  const found = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", `${STACK}-${service}-1`], { encoding: "utf8" });
  return found.status === 0 && found.stdout.trim() === "true";
}
