import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCallEvent } from "prime-agent";
import { enabled, log } from "./log.ts";

/*
 * Installs the run-time half of the send guard (c37) in each Python kernel: kernel-guard.py checks the subprocesses, HTTP writes,
 * SMTP connects and MCP calls a cell makes as they happen, which catches a send whose text is built at run time.
 * The prelude runs the file once per kernel. A file that fails to load lets the cell run, like the tool_call guard.
 */
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const FILE = join(HERE, "kernel-guard.py");
// kernel-cwd.py reports the kernel's cwd to the tool_call guard (kernel-cwd.ts). It has its own flag, so a kernel that loaded the
// send guard before this file existed gets it on its next cell.
const CWD_FILE = join(HERE, "kernel-cwd.py");
// kernel-own.py records each path under ~/scratch the kernel makes in the session's owned.json (c130). It has its own flag for the same reason.
const OWN_FILE = join(HERE, "kernel-own.py");
// kernel-read.py refuses reads of another family's session transcripts (chat-057a, 10-19 and 10-20). It has its own flag for the same reason.
const READ_FILE = join(HERE, "kernel-read.py");

export const PRELUDE_SOURCE = `
import sys
if not getattr(sys, "global_rules_send_guard", False):
    try:
        exec(compile(open(${JSON.stringify(FILE)}).read(), ${JSON.stringify(FILE)}, "exec"), {"__name__": "global_rules_send_guard", "__file__": ${JSON.stringify(FILE)}})
    except Exception as error:
        sys.global_rules_send_guard = "failed"
        print(f"global-rules: the kernel send guard did not load: {error}", file=sys.stderr)
if not getattr(sys, "global_rules_kernel_cwd", False):
    sys.global_rules_kernel_cwd = True
    try:
        exec(compile(open(${JSON.stringify(CWD_FILE)}).read(), ${JSON.stringify(CWD_FILE)}, "exec"), {"__name__": "global_rules_kernel_cwd", "__file__": ${JSON.stringify(CWD_FILE)}})
    except Exception as error:
        print(f"global-rules: the kernel cwd report did not load: {error}", file=sys.stderr)
if not getattr(sys, "global_rules_kernel_own", False):
    sys.global_rules_kernel_own = True
    try:
        exec(compile(open(${JSON.stringify(OWN_FILE)}).read(), ${JSON.stringify(OWN_FILE)}, "exec"), {"__name__": "global_rules_kernel_own", "__file__": ${JSON.stringify(OWN_FILE)}})
    except Exception as error:
        print(f"global-rules: the kernel owner record did not load: {error}", file=sys.stderr)
if not getattr(sys, "global_rules_kernel_read", False):
    sys.global_rules_kernel_read = True
    try:
        exec(compile(open(${JSON.stringify(READ_FILE)}).read(), ${JSON.stringify(READ_FILE)}, "exec"), {"__name__": "global_rules_kernel_read", "__file__": ${JSON.stringify(READ_FILE)}})
    except Exception as error:
        print(f"global-rules: the kernel transcript guard did not load: {error}", file=sys.stderr)
`;

/** One line, so the cell's own line numbers in a traceback move by one. */
export const PRELUDE = `exec(compile(${JSON.stringify(PRELUDE_SOURCE)}, "<global-rules send guard>", "exec"), {})\n`;

export function withKernelGuard(code: unknown): string | undefined {
	if (typeof code !== "string" || code.startsWith(PRELUDE)) return undefined;
	return PRELUDE + code;
}

/** A handler error fails open: the cell then runs unchanged. */
export function onToolCall(event: ToolCallEvent): undefined {
	try {
		if (!enabled("GLOBAL_RULES_GUARD") || event.toolName !== "ipython") return undefined;
		const input = event.input as Record<string, unknown>;
		const code = withKernelGuard(input.code);
		if (code !== undefined) input.code = code;
	} catch (err) {
		log("kernel-guard", `handler error, cell runs unchanged :: ${err instanceof Error ? err.stack : String(err)}`);
	}
	return undefined;
}
