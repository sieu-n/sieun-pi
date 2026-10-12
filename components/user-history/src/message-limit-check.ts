import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { messageLimitRefusal } from "./shared/reply-lint.ts";

/*
 * The c43 limit check for agent messages a chat sends. agent_message.send runs in the chat's Python kernel and reaches the host through
 * rlm.host_request, which no extension event sees, so the chat's ipython cells get one prelude line that runs message-limit-check.py once per
 * kernel. That file wraps host_request: an "agent_message.send" whose text states a limit with no evidence raises LimitRefused and nothing is
 * sent. It runs this file with the text on stdin, which prints {"refusal": string | null}, so the rule stays the one reply-lint.ts holds.
 */
const FILE = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "message-limit-check.py");

const PRELUDE_SOURCE = `
import sys
if not getattr(sys, "user_history_message_check", False):
    try:
        exec(compile(open(${JSON.stringify(FILE)}).read(), ${JSON.stringify(FILE)}, "exec"), {"__name__": "user_history_message_check", "__file__": ${JSON.stringify(FILE)}})
    except Exception as error:
        sys.user_history_message_check = "failed"
        print(f"user-history: the agent message limit check did not load: {error}", file=sys.stderr)
`;

/** One line, so the cell's own line numbers in a traceback move by one. */
export const MESSAGE_CHECK_PRELUDE = `exec(compile(${JSON.stringify(PRELUDE_SOURCE)}, "<user-history message check>", "exec"), {})\n`;

/** The cell with the prelude in front, or undefined when it already has it. */
export function withMessageCheck(code: string): string | undefined {
  return code.includes(MESSAGE_CHECK_PRELUDE) ? undefined : MESSAGE_CHECK_PRELUDE + code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { message } = JSON.parse(readFileSync(0, "utf8")) as { message?: unknown };
  process.stdout.write(`${JSON.stringify({ refusal: typeof message === "string" ? messageLimitRefusal(message) : null })}\n`);
}
