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
const FILE = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "kernel-guard.py");

export const PRELUDE_SOURCE = `
import sys
if not getattr(sys, "global_rules_send_guard", False):
    try:
        exec(compile(open(${JSON.stringify(FILE)}).read(), ${JSON.stringify(FILE)}, "exec"), {"__name__": "global_rules_send_guard", "__file__": ${JSON.stringify(FILE)}})
    except Exception as error:
        sys.global_rules_send_guard = "failed"
        print(f"global-rules: the kernel send guard did not load: {error}", file=sys.stderr)
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
