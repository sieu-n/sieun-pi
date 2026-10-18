import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { judgeShellText, type Verdict } from "./guard.ts";
import { applyOwnerOk, httpSend, mcpSend, ownerOkToken, refusal } from "./send-guard.ts";
import { recordSend, sendReason, sessionOf } from "./send-log.ts";
import { judgeKernelShell } from "./auto-sns-agent.ts";

/*
 * The runtime half of the send guard (c37) and auto-sns-agent's repo guard. kernel-guard.py runs this for a send it sees at run time in the Python kernel:
 * a subprocess, an HTTP write or an MCP call whose text the tool_call guard could not read. It prints one JSON line,
 * {"block": false} or {"block": true, "reason": "..."}, and judges with the same rules as the tool_call guard.
 */

export type Check =
	| { kind: "shell"; text: string; cwd: string; approval?: string; repo?: boolean }
	| { kind: "http"; method: string; url: string; body?: string; approval?: string }
	| { kind: "mcp"; server: string; tool: string; args: string; approval?: string };

export function judgeCheck(check: Check, record = false): { block: false } | { block: true; reason: string } {
	const push = (what: string | null, command: string): Verdict[] =>
		what ? [{ rule: "send", command, reason: refusal(what) }] : [];
	const verdicts =
		check.kind === "shell"
			? judgeShellText(check.text, check.cwd).filter((v) => v.rule === "send")
			: check.kind === "http"
				? push(httpSend(check.method, check.url, check.body ?? ""), `${check.method} ${check.url}`)
				: push(mcpSend(check.server, check.tool, check.args), `mcp ${check.server} ${check.tool} ${check.args.slice(0, 300)}`);
	const approval = `${check.approval ?? ""}\n${check.kind === "shell" ? check.text : ""}`;
	const left = applyOwnerOk(verdicts, approval);
	if (record) {
		// The kernel's send-log line (c37), once per checked call, with the kernel's RLM_SESSION_DIR.
		const token = ownerOkToken(approval);
		for (const v of verdicts.filter((v) => v.rule === "send")) {
			const refused = left.some((l) => l.command === v.command);
			recordSend({ decision: refused ? "refused" : "allowed", layer: "kernel", ...sessionOf(process.env.RLM_SESSION_DIR), target: v.command, reason: sendReason(v.reason), ownerOk: token });
		}
	}
	return left.length ? { block: true, reason: left[0].reason } : { block: false };
}

/** A git write the kernel starts (`repo: true`) also goes through auto-sns-agent's repo guard with the kernel's real cwd. */
export async function judgeKernelCheck(check: Check): Promise<{ block: false } | { block: true; reason: string }> {
	const result = judgeCheck(check, true);
	if (result.block || check.kind !== "shell" || !check.repo) return result;
	return (await judgeKernelShell(check.text, check.cwd, process.env.RLM_SESSION_DIR)) ?? result;
}

/*
 * --serve judges one check per stdin line, {"id": n, "cwd": "...", "check": {...}}, and answers {"id": n, "block": ...} on one stdout line,
 * in order. It exits after IDLE_MS (or argv[3] ms) with no check. kernel-guard.py keeps one of these per process: a fresh
 * `node send-check.ts` per check started 8 to 12 times a second on us-metal02 on 10-18, at 0.11 CPU s each. The kernel restarts it when its environment or a global-rules source file changes, so each
 * verdict reads the same rules and environment a fresh run would. A check that throws answers {"id": n, "error": ...}, which the kernel
 * lets through, as it lets through a one-shot run that prints nothing.
 */
export async function serve(input: NodeJS.ReadableStream = process.stdin, write = (line: string) => process.stdout.write(line), idleMs = IDLE_MS): Promise<void> {
	const { createInterface } = await import("node:readline");
	// A judge with no check for idleMs exits, so an idle kernel does not hold its 55 to 65 MB; the next check starts a fresh one.
	let idle = setTimeout(() => process.exit(0), idleMs);
	for await (const line of createInterface({ input, crlfDelay: Infinity })) {
		clearTimeout(idle);
		idle = setTimeout(() => process.exit(0), idleMs);
		if (!line.trim()) continue;
		let id: unknown = null;
		try {
			const request = JSON.parse(line) as { id: unknown; cwd?: string; check: Check };
			id = request.id;
			if (request.cwd) {
				try {
					process.chdir(request.cwd);
				} catch {
					// A cwd that is gone leaves the last one; every rule reads check.cwd, not process.cwd().
				}
			}
			write(`${JSON.stringify({ id, ...(await judgeKernelCheck(request.check)) })}\n`);
		} catch (error) {
			write(`${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`);
		}
	}
	clearTimeout(idle);
}

const IDLE_MS = 120_000;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv[2] === "--serve") {
		// stdout carries only answers, so a stray console.log in a rule module cannot read as a verdict.
		console.log = console.info = console.warn = console.error;
		await serve(process.stdin, (line) => process.stdout.write(line), Number(process.argv[3]) || IDLE_MS);
	} else {
		const result = await judgeKernelCheck(JSON.parse(readFileSync(0, "utf8")) as Check);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	}
}
