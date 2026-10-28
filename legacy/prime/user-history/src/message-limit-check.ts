import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./main-module.ts";
import { steerWaitNote } from "./shared/steer-wait.ts";

/*
 * The check for agent messages a chat or a job of a chat sends. agent_message.send runs in the session's Python kernel and reaches the host
 * through rlm.host_request, which no extension event sees, so the session's ipython cells get one prelude line that runs
 * message-limit-check.py once per kernel and file version. That file wraps host_request: a message to a job that holds it for another
 * thread's go (c47) goes out and the cell prints the c47 note, and a send the daemon timed out on returns an "unconfirmed" receipt (p334). It
 * runs this file with {message, dataDir, role} on stdin, which prints {"note": string | null}.
 */
const FILE = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "message-limit-check.py");
/** The file's VERSION: a kernel that installed an older one runs the new file at its next cell. */
const VERSION = Number(/^VERSION = (\d+)$/m.exec(readFileSync(FILE, "utf8"))?.[1] ?? 0);

// The version is read from the file at each cell, so a session that loaded this prelude picks up a newer file without a reload: until 10-18
// the prelude held the VERSION of its load, and Mac roots loaded before 3a7e058 (VERSION 15) never got its cross-host sends.
const preludeSource = (dataDir: string | null): string => `
import sys
sys.user_history_data_dir = ${dataDir === null ? "None" : JSON.stringify(dataDir)}
try:
    import re as _re
    _v = int(_re.search(r"^VERSION = (\\d+)$", open(${JSON.stringify(FILE)}).read(), _re.M).group(1))
except Exception:
    _v = ${VERSION}
if getattr(sys, "user_history_message_check", None) != _v:
    try:
        exec(compile(open(${JSON.stringify(FILE)}).read(), ${JSON.stringify(FILE)}, "exec"), {"__name__": "user_history_message_check", "__file__": ${JSON.stringify(FILE)}, "DATA_DIR": ${dataDir === null ? "None" : JSON.stringify(dataDir)}})
    except Exception as error:
        sys.user_history_message_check = _v
        print(f"user-history: the agent message check did not load: {error}", file=sys.stderr)
`;

/**
 * One line, so the cell's own line numbers in a traceback move by one. `dataDir` is the chat server's directory, where the job names live;
 * null in a session outside the chats, whose kernel gets the send checks and records no brief.
 */
export const messageCheckPrelude = (dataDir: string | null): string =>
  `exec(compile(${JSON.stringify(preludeSource(dataDir))}, "<user-history message check>", "exec"), {})\n`;

/** The cell with the prelude in front, or undefined when it already has it. */
export function withMessageCheck(code: string, dataDir: string | null): string | undefined {
  const prelude = messageCheckPrelude(dataDir);
  return code.includes(prelude) ? undefined : prelude + code;
}

/** The note for a message to a job (`role` "child") that holds the job for another thread's go or the owner's ok on a push (`steerWaitNote`, c47). */
export function checkMessage(message: string, role?: string): string | null {
  return role === "child" ? steerWaitNote(message) : null;
}

if (isMain(import.meta.url)) {
  const { message, role } = JSON.parse(readFileSync(0, "utf8")) as { message?: unknown; role?: unknown };
  const note = typeof message === "string" ? checkMessage(message, typeof role === "string" ? role : undefined) : null;
  process.stdout.write(`${JSON.stringify({ note })}\n`);
}
