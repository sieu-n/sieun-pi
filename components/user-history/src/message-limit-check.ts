import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { jobNames } from "./limit-names.ts";
import { messageLimitRefusal } from "./shared/reply-lint.ts";

/*
 * The c43 limit check for agent messages a chat or a job of a chat sends. agent_message.send runs in the session's Python kernel and reaches the
 * host through rlm.host_request, which no extension event sees, so the session's ipython cells get one prelude line that runs
 * message-limit-check.py once per kernel. That file wraps host_request: an "agent_message.send" whose text states a limit with no evidence
 * raises LimitRefused and nothing is sent. It runs this file with {message, dataDir} on stdin, which prints {"refusal": string | null}, so the
 * rule stays the one reply-lint.ts holds. Job names are read only when the text has a claim.
 */
const FILE = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "message-limit-check.py");

const preludeSource = (dataDir: string): string => `
import sys
if not getattr(sys, "user_history_message_check", False):
    try:
        exec(compile(open(${JSON.stringify(FILE)}).read(), ${JSON.stringify(FILE)}, "exec"), {"__name__": "user_history_message_check", "__file__": ${JSON.stringify(FILE)}, "DATA_DIR": ${JSON.stringify(dataDir)}})
    except Exception as error:
        sys.user_history_message_check = "failed"
        print(f"user-history: the agent message limit check did not load: {error}", file=sys.stderr)
`;

/** One line, so the cell's own line numbers in a traceback move by one. `dataDir` is the chat server's directory, where the job names live. */
export const messageCheckPrelude = (dataDir: string): string =>
  `exec(compile(${JSON.stringify(preludeSource(dataDir))}, "<user-history message check>", "exec"), {})\n`;

/** The cell with the prelude in front, or undefined when it already has it. */
export function withMessageCheck(code: string, dataDir: string): string | undefined {
  const prelude = messageCheckPrelude(dataDir);
  return code.includes(prelude) ? undefined : prelude + code;
}

/** The refusal for one message, with job names read from `dataDir` only when the text has a claim. */
export async function checkMessage(message: string, dataDir: string | undefined): Promise<string | null> {
  const refusal = messageLimitRefusal(message);
  return refusal && dataDir ? messageLimitRefusal(message, await jobNames(dataDir)) : refusal;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { message, dataDir } = JSON.parse(readFileSync(0, "utf8")) as { message?: unknown; dataDir?: unknown };
  const refusal = typeof message === "string" ? await checkMessage(message, typeof dataDir === "string" ? dataDir : undefined) : null;
  process.stdout.write(`${JSON.stringify({ refusal })}\n`);
}
