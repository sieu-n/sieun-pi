import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { jobNames } from "./limit-names.ts";
import { messageLimitRefusal } from "./shared/reply-lint.ts";
import { steerWaitRefusal } from "./shared/steer-wait.ts";

/*
 * The c43 limit check for agent messages a chat or a job of a chat sends. agent_message.send runs in the session's Python kernel and reaches the
 * host through rlm.host_request, which no extension event sees, so the session's ipython cells get one prelude line that runs
 * message-limit-check.py once per kernel and file version. That file wraps host_request: an "agent_message.send" whose text states a limit
 * with no evidence, or a message to a job that holds it for another thread's go (c47), raises LimitRefused and nothing is sent, and a send the
 * daemon timed out on returns an "unconfirmed" receipt (p334). It runs this file with {message, dataDir, role} on stdin, which prints {"refusal": string | null}, so the rule stays the one reply-lint.ts holds. Job
 * names are read only when the text has a claim.
 */
const FILE = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "message-limit-check.py");
/** The file's VERSION: a kernel that installed an older one runs the new file at its next cell. */
const VERSION = Number(/^VERSION = (\d+)$/m.exec(readFileSync(FILE, "utf8"))?.[1] ?? 0);

const preludeSource = (dataDir: string): string => `
import sys
if getattr(sys, "user_history_message_check", None) != ${VERSION}:
    try:
        exec(compile(open(${JSON.stringify(FILE)}).read(), ${JSON.stringify(FILE)}, "exec"), {"__name__": "user_history_message_check", "__file__": ${JSON.stringify(FILE)}, "DATA_DIR": ${JSON.stringify(dataDir)}})
    except Exception as error:
        sys.user_history_message_check = ${VERSION}
        print(f"user-history: the agent message check did not load: {error}", file=sys.stderr)
`;

/** One line, so the cell's own line numbers in a traceback move by one. `dataDir` is the chat server's directory, where the job names live. */
export const messageCheckPrelude = (dataDir: string): string =>
  `exec(compile(${JSON.stringify(preludeSource(dataDir))}, "<user-history message check>", "exec"), {})\n`;

/** The cell with the prelude in front, or undefined when it already has it. */
export function withMessageCheck(code: string, dataDir: string): string | undefined {
  const prelude = messageCheckPrelude(dataDir);
  return code.includes(prelude) ? undefined : prelude + code;
}

/**
 * The refusal for one message, with job names read from `dataDir` only when the text has a claim. A message to a job (`role` "child") is also
 * refused when it holds the job for another thread's go or the owner's ok on a push (`steerWaitRefusal`, c47).
 */
export async function checkMessage(message: string, dataDir: string | undefined, role?: string): Promise<string | null> {
  const wait = role === "child" ? steerWaitRefusal(message) : null;
  if (wait) return wait;
  const refusal = messageLimitRefusal(message);
  return refusal && dataDir ? messageLimitRefusal(message, await jobNames(dataDir)) : refusal;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { message, dataDir, role } = JSON.parse(readFileSync(0, "utf8")) as { message?: unknown; dataDir?: unknown; role?: unknown };
  const refusal = typeof message === "string" ? await checkMessage(message, typeof dataDir === "string" ? dataDir : undefined, typeof role === "string" ? role : undefined) : null;
  process.stdout.write(`${JSON.stringify({ refusal })}\n`);
}
