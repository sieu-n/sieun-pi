import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function logPath(): string {
	return process.env.GLOBAL_RULES_LOG || join(tmpdir(), "global-rules.log");
}

/** Never throws: callers sit on the tool_call hot path, and a throw there fails the tool call. */
export function log(scope: string, message: string): void {
	try {
		appendFileSync(logPath(), `${new Date().toISOString()} [${scope}] ${message}\n`);
	} catch {
		// A log that cannot be written is not a reason to fail a tool call.
	}
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const OFF = new Set(["off", "0", "false"]);

/** `GLOBAL_RULES=off` turns every feature off; `GLOBAL_RULES_<FEATURE>=off` turns one off. */
export function enabled(envKey: string): boolean {
	return !OFF.has((process.env.GLOBAL_RULES || "").toLowerCase()) && !OFF.has((process.env[envKey] || "").toLowerCase());
}
