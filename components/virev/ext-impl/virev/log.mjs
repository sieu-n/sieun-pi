/**
 * Shared helpers for the virev impl modules.
 *
 * Nothing here may throw: every caller is on the hot path of an `ipython` tool
 * call, and a throw inside a tool_call handler fails the tool call itself.
 */
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG_PATH = process.env.VIREV_EXT_LOG || join(tmpdir(), "virev-ext.log");

export function logPath() {
	return LOG_PATH;
}

export function log(scope, message) {
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} [${scope}] ${message}\n`);
	} catch {
		// A log that cannot be written is not a reason to fail a tool call.
	}
}

/** `VIREV_EXT=off` kills the whole extension; `VIREV_<FEATURE>=off` kills one feature. */
export function featureEnabled(envKey) {
	const all = (process.env.VIREV_EXT || "").toLowerCase();
	if (all === "off" || all === "0" || all === "false") return false;
	const one = (process.env[envKey] || "").toLowerCase();
	return !(one === "off" || one === "0" || one === "false");
}

/**
 * Test seam for the fail-open evidence in REPORT.md. `inner` throws where the
 * feature's own try/catch sees it; `outer` throws before it, so the shell's
 * try/catch handles the error.
 */
export function faultInject(scope, phase) {
	if ((process.env.VIREV_FAULT_INJECT || "") === `${scope}:${phase}`) {
		throw new Error(`virev fault injection: ${scope}:${phase}`);
	}
}
