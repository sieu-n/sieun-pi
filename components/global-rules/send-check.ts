import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { judgeShellText, type Verdict } from "./guard.ts";
import { applyOwnerOk, httpSend, mcpSend, refusal } from "./send-guard.ts";

/*
 * The runtime half of the send guard (c37). kernel-guard.py runs this for a send it sees at run time in the Python kernel:
 * a subprocess, an HTTP write or an MCP call whose text the tool_call guard could not read. It prints one JSON line,
 * {"block": false} or {"block": true, "reason": "..."}, and judges with the same rules as the tool_call guard.
 */

export type Check =
	| { kind: "shell"; text: string; cwd: string; approval?: string }
	| { kind: "http"; method: string; url: string; body?: string; approval?: string }
	| { kind: "mcp"; server: string; tool: string; args: string; approval?: string };

export function judgeCheck(check: Check): { block: false } | { block: true; reason: string } {
	const push = (what: string | null, command: string): Verdict[] =>
		what ? [{ rule: "send", command, reason: refusal(what) }] : [];
	const verdicts =
		check.kind === "shell"
			? judgeShellText(check.text, check.cwd).filter((v) => v.rule === "send")
			: check.kind === "http"
				? push(httpSend(check.method, check.url, check.body ?? ""), `${check.method} ${check.url}`)
				: push(mcpSend(check.server, check.tool, check.args), `mcp ${check.server} ${check.tool}`);
	const left = applyOwnerOk(verdicts, `${check.approval ?? ""}\n${check.kind === "shell" ? check.text : ""}`);
	return left.length ? { block: true, reason: left[0].reason } : { block: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = judgeCheck(JSON.parse(readFileSync(0, "utf8")) as Check);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
