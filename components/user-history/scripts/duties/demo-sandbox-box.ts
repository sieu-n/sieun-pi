import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { MAC_HOST, macAway } from "./mac-reach.ts";

/**
 * The box side of the Demo sandbox works duty (demo-sandbox.ts). The demo and its walk live on the owner's MacBook Pro, so this runs
 * demo-sandbox.ts from the Mac's sieun-pi checkout over `ssh mac` and passes its output through. It reads Tailscale first: a Mac that is
 * offline gives a `host_away` item and no ssh, so the runner reruns the duty once the Mac is back (`Duties.rerunHostBack`). From 10-24 to
 * 10-27 frontend bro's d1 ran its bare `ssh mac` at 06:25 KST four days in a row, timed out on the sleeping Mac each time, read "the
 * precheck failed" and started a duty job that could do nothing.
 */

/** PATH for the Mac: a plain `ssh mac` PATH has no node (10-18 to 10-19, `env: node: No such file or directory`). */
export const MAC_COMMAND = "export PATH=/Users/sieunpark/.hermes/node/bin:$PATH; cd ~/Documents/Github/sieun-pi/components/user-history || exit 2; " +
  "f=$(mktemp); OUTPUT_FILE=$f node --import tsx scripts/duties/demo-sandbox.ts; s=$?; cat $f; rm -f $f; exit $s";

export interface BoxDeps {
  away: () => Promise<FlaggedSlice | undefined>;
  ssh: () => Promise<{ code: number; stdout: string; stderr: string }>;
}

/** The precheck output text and exit code: the Mac's own output when ssh reaches it, or a `host_away` output when Tailscale lists it offline. */
export async function boxPrecheck(deps: BoxDeps): Promise<{ code: number; text: string; stderr: string }> {
  const away = await deps.away();
  if (away) {
    const output: PrecheckOutput = { metrics: {}, flagged: [away] };
    return { code: 0, text: JSON.stringify(output), stderr: "" };
  }
  const { code, stdout, stderr } = await deps.ssh();
  return { code, text: stdout, stderr };
}

const ssh = (): Promise<{ code: number; stdout: string; stderr: string }> => new Promise(resolve => {
  execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", MAC_HOST, MAC_COMMAND], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, text, stderr } = await boxPrecheck({ away: () => macAway(MAC_HOST, "the demo walk, page times, restarts and SSR timeouts are", Date.now()), ssh });
  if (stderr) process.stderr.write(stderr);
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
  process.exitCode = code;
}
