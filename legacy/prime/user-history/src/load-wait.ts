/*
 * A job that polls the Mac's load or free memory and sleeps until it drops is an invented wait (c47) on a number no measurement backs (c43).
 * 10-13 00:30 KST: 8 such loops (gate-waiter.py, load_gate.py, gate.py, gate-wait.py, part-5-waiter.py) held 8 jobs of frontend bro and SEO guy
 * "working" for 2 min to 1 h 51 min, waiting for load1 under 20 or 30 and free memory at 30% or 20%. load1 stayed 33 to 311 from 13:33Z, so none
 * ran its check, and each job kept its worker and Python kernel the whole time. Such code runs (owner 10-18: "all these should be modeled as a
 * soft cap"), and the chat extension adds LOAD_WAIT_NOTE to its tool result. A tool result reaches the agent only when the call ends, so the
 * call's wait also ends at its first sleep after a load read: an ipython cell gets the load-wait-end.py prelude and a bash command gets
 * SHELL_END in front.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Reads the machine's load average or memory pressure: Python, Node, sysctl, uptime or macOS memory_pressure. */
const LOAD_READ = /\bos\.getloadavg\b|\bos\.loadavg\s*\(|\bvm\.loadavg\b|\bmemory_pressure\b|\buptime\b/;
const LOOP = /\bwhile\b|\buntil\b|\bfor\s+\w+\s+in\b|\bfor\s*\(/;
const SLEEP = /\bsleep\s*\(|\bsleep\s+\d|\bsetTimeout\s*\(/;
/** The loop ends on a reading: a comparison with a number, and an exit, break or return, a `while` or `until` test on it, or a shell loop's `done`. */
const THRESHOLD = /[<>]=?\s*\d|-(?:lt|le|gt|ge)\s+\d/;
const EXIT = /\bbreak\b|\bsys\.exit\b|\bprocess\.exit\b|\bexit\s*\(|\breturn\b|\buntil\b|\bdone\b|\bwhile\b[^\n:]*(?:[<>]=?\s*\d|-(?:lt|le|gt|ge)\s+\d)/;

/** Whether code (a script, or kernel code that writes or runs one) loops on load or free memory and sleeps until it passes a number. */
export function loadWaitLoop(code: string): boolean {
  // A script written from a one-line string literal carries \n and \t escapes; they count as the line breaks they become.
  const text = code.replace(/\\[nt]/g, "\n");
  return LOAD_READ.test(text) && LOOP.test(text) && SLEEP.test(text) && THRESHOLD.test(text) && EXIT.test(text);
}

export const LOAD_WAIT_NOTE = "Note (c47, c43): this code waits in a loop for the Mac's load or free memory to drop. It ran, and its first " +
  "sleep after a load read ended the wait, in the cell and in the shell and Python commands it started. No measurement backs that wait: on " +
  "10-12 load stayed above 30 for hours, and 8 such loops held jobs 2 min to 1 h 51 min without running their check. Run the check, build or " +
  "browser walk now. If it fails, report the failure with the load and memory you measured at that moment.";

const FILE = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "load-wait-end.py");
const SHIM = join(dirname(FILE), "load-wait-shim");
const VERSION = Number(/^VERSION = (\d+)$/m.exec(readFileSync(FILE, "utf8"))?.[1] ?? 0);

/** One line that installs load-wait-end.py once per kernel and file version and arms the cell it heads. */
export const LOAD_WAIT_PRELUDE = `exec(compile(${JSON.stringify(`
import sys
try:
    if getattr(sys, "user_history_load_wait_end", None) != ${VERSION}:
        exec(compile(open(${JSON.stringify(FILE)}).read(), ${JSON.stringify(FILE)}, "exec"), {"__name__": "user_history_load_wait_end", "__file__": ${JSON.stringify(FILE)}})
    sys.user_history_load_wait_arm()
except Exception as error:
    print(f"user-history: the load-wait end did not load: {error}", file=sys.stderr)
`)}, "<user-history load wait>", "exec"), {})\n`;

/** The shell lines in front of a bash command that loops on load: it and its Python processes end at their first sleep after a load read. */
export const SHELL_END = `. ${JSON.stringify(join(SHIM, "load-wait.sh"))}\n` +
  `export PYTHONPATH=${JSON.stringify(SHIM)}\${PYTHONPATH:+:\$PYTHONPATH}\n`;

const codeOf = (toolName: string, input: Record<string, unknown>): string | undefined => {
  const code = toolName === "ipython" ? input.code : toolName === "bash" ? input.command : undefined;
  return typeof code === "string" ? code : undefined;
};

/** The note for code a chat or its job runs: an ipython cell or a bash command that holds a load-wait loop gets LOAD_WAIT_NOTE on its result. */
export function loadWaitNote(toolName: string, input: Record<string, unknown>): string | undefined {
  const code = codeOf(toolName, input);
  return code !== undefined && loadWaitLoop(code) ? LOAD_WAIT_NOTE : undefined;
}

/** Ends the wait of a load-wait call after its first check: the input with the prelude or SHELL_END in front, or undefined for other calls. */
export function endLoadWait(toolName: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  const code = codeOf(toolName, input);
  if (code === undefined || !loadWaitLoop(code)) return undefined;
  return toolName === "ipython" ? { ...input, code: LOAD_WAIT_PRELUDE + code } : { ...input, command: SHELL_END + code };
}
