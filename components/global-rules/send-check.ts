import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { judgeShellText, type Verdict } from "./guard.ts";
import { applyOwnerOk, httpSend, mcpSend, ownerOkToken, refusal } from "./send-guard.ts";
import { recordSend, sendReason, sessionOf } from "./send-log.ts";
import { ciRunHttp, isCiRunKeeper } from "./ci-run-guard.ts";
import { judgeKernelShell } from "./auto-sns-agent.ts";

/*
 * The runtime half of the send guard (c37), the CI run guard and auto-sns-agent's repo guard. kernel-guard.py runs this for a send it sees at run time in the Python kernel:
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
	const ciRun = isCiRunKeeper(process.env.RLM_SESSION_DIR) ? [] : ["ci-run"];
	const verdicts =
		check.kind === "shell"
			? judgeShellText(check.text, check.cwd).filter((v) => v.rule === "send" || ciRun.includes(v.rule))
			: check.kind === "http"
				? [
						...push(httpSend(check.method, check.url, check.body ?? ""), `${check.method} ${check.url}`),
						...[ciRunHttp(check.method, check.url)].filter((v): v is Verdict => v !== null && ciRun.includes(v.rule)),
					]
				: push(mcpSend(check.server, check.tool, check.args), `mcp ${check.server} ${check.tool} ${check.args.slice(0, 300)}`);
	const approval = `${check.approval ?? ""}\n${check.kind === "shell" ? check.text : ""}`;
	const left = applyOwnerOk(verdicts, approval);
	if (record) {
		// The kernel's send-log line (c37): this process runs once per checked call, with the kernel's RLM_SESSION_DIR.
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = await judgeKernelCheck(JSON.parse(readFileSync(0, "utf8")) as Check);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
