import { spawn } from "node:child_process";
import type { Repl } from "./aside-repl.ts";

/**
 * A box Chrome on us-metal02 as a REPL that keeps its scope between calls, for d1's offline walk of the Mac's 5180 (demo-sandbox-walk.ts).
 * It is the aside-browser skill's box runner (skills/aside-browser/box/box.mjs): a headful Chrome on its own Xvfb display that reaches the
 * Mac's localhost through an ssh tunnel back to the Mac (box/loopback.mjs), with the same Playwright-style globals as the Aside REPL. The walk
 * opens no page that needs a login, so it needs none of the owner's Aside. From 11-16 21:25Z to 11-18 the walk drove his Aside over
 * `aside mcp`, the Mac rebooted near 05:35 KST on 11-18 with no Aside window, and every walk failed with "Failed to request daemon auth
 * challenge: fetch failed", which held walk_problems at 1 while 5180 answered.
 */

/** The box that runs the Chrome, and its ssh name for the Mac, as the aside-browser skill starts it from a Mac kernel (`_BoxRunner._command`). */
export const BOX_HOST = "us-metal02";
export const LOOPBACK_HOST = "mac";
const REMOTE_BOX_DIR = "~/.prime/agent/skills/aside-browser/box";

/** The ssh command that starts one box runner on BOX_HOST whose Chrome loads LOOPBACK_HOST's localhost. */
export function boxCommand(): [string, string[]] {
  return ["ssh", ["-T", "-o", "BatchMode=yes", BOX_HOST, `bash -lc 'cd ${REMOTE_BOX_DIR} && BOX_LOOPBACK_VIA=${LOOPBACK_HOST} exec node box.mjs'`]];
}

/** measured: on 2026-11-03 on us-metal02 a runner exited 0.16 to 0.28 s after its stdin closed (3 runs), so one still up after 5 s gets a kill. */
const STOP_MS = 5_000;

/**
 * One box runner over JSON lines, so the REPL scope and its tabs live for the whole run: `{id, code}` goes in, `{id, out}` or `{id, error}`
 * comes back, where `out` is the code's console.log lines. `call` runs `body` (the inside of an async function, which returns a JSON value)
 * and resolves that value; a REPL error or a runner that exits rejects, with the runner's last stderr lines.
 */
export function boxRepl(command: string, args: readonly string[]): Repl {
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", stderr = "", nextId = 0, exited: string | null = null;
  const waiting = new Map<number, (message: { out?: string; error?: string }) => void>();
  const fail = (why: string) => {
    exited = `the box runner ${why}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`;
    for (const answer of waiting.values()) answer({ error: exited });
    waiting.clear();
  };
  child.on("error", error => fail(`did not start (${error.message})`));
  child.on("exit", code => fail(`exited with code ${code}`));
  child.stdin.on("error", () => { /* the exit handler reports it */ });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      let message: { id?: number; out?: string; error?: string };
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id === "number") { waiting.get(message.id)?.(message); waiting.delete(message.id); }
    }
  });
  return {
    async call<T>(_title: string, body: string): Promise<T> {
      if (exited) throw new Error(exited);
      const id = ++nextId;
      const code = `{ const __walkValue = await (async () => { ${body} })(); console.log("WALK_RESULT " + JSON.stringify(__walkValue ?? null)); }`;
      const answer = await new Promise<{ out?: string; error?: string }>(resolve => {
        waiting.set(id, resolve);
        child.stdin.write(JSON.stringify({ id, code }) + "\n");
      });
      if (answer.error !== undefined) throw new Error(answer.error.split("\n")[0]);
      const line = (answer.out ?? "").split("\n").reverse().find(entry => entry.startsWith("WALK_RESULT "));
      if (!line) throw new Error(`no result in the REPL output: ${(answer.out ?? "").slice(0, 300)}`);
      return JSON.parse(line.slice("WALK_RESULT ".length)) as T;
    },
    stop() { child.stdin.end(); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, STOP_MS).unref(); },
  };
}
