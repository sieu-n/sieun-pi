import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "prime-agent";
import { enabled, log } from "./log.ts";
import { judgeCuaShell } from "./cua-guard.ts";
import { applyOwnerOk, judgeSendPython, judgeSendShell, ownerOkToken } from "./send-guard.ts";
import { recordSend, sendReason, sessionOf } from "./send-log.ts";
import { PY_STRING, balancedSlice } from "./shell.ts";
import { judgeSieunPi } from "./sieun-pi.ts";

export interface Verdict {
	rule: "sieun-pi" | "send";
	command: string;
	reason: string;
}

export interface Candidate {
	source: string;
	text: string;
}

const MAX_CODE_BYTES = 200000;

const EXEC_CALL =
	/(?:^|[^\w.])(?:\w+\s*\.\s*)?(?:bash|run|Popen|call|check_call|check_output|getoutput|getstatusoutput|system|popen)\s*\(/g;
const TRIPLE_DOUBLE = '"""';
const TRIPLE_SINGLE = "'''";

function unquote(literal: string): string {
	const body = literal.replace(/^[rbfuRBFU]{0,2}/, "");
	const triple = body.startsWith(TRIPLE_DOUBLE) || body.startsWith(TRIPLE_SINGLE);
	const inner = triple ? body.slice(3, -3) : body.slice(1, -1);
	return inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(['"\\])/g, "$1");
}


/**
 * A `%%bash` cell is one shell script. Otherwise look for `!` line escapes and
 * for literal calls to bash, subprocess, and os. Computed arguments are
 * outside this static check. See README "Limits and verification".
 */
export function extractShellCandidates(code: string): Candidate[] {
	const out: Candidate[] = [];
	if (typeof code !== "string" || !code.trim()) return out;
	if (code.length > MAX_CODE_BYTES) return out;

	const lines = code.split("\n");
	let first = 0;
	while (first < lines.length && lines[first].trim() === "") first++;
	const magic = lines[first]?.match(/^\s*%%(bash|sh|zsh|shell)\b/);
	if (magic) {
		out.push({ source: `%%${magic[1]}`, text: lines.slice(first + 1).join("\n") });
		return out;
	}

	for (const line of lines) {
		const bang = line.match(/^\s*!(?![=!])(.+)$/);
		if (bang) out.push({ source: "! escape", text: bang[1] });
	}

	const callSites = code.replace(new RegExp(`${PY_STRING.source}|#[^\n]*`, "g"), (text) => " ".repeat(text.length));
	EXEC_CALL.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = EXEC_CALL.exec(callSites)) !== null) {
		const region = balancedSlice(code, code.indexOf("(", m.index + m[0].length - 1));
		const head = region.replace(/^\s*/, "");
		if (head.startsWith("[")) {
			const listEnd = head.indexOf("]");
			const list = listEnd === -1 ? head : head.slice(0, listEnd);
			const parts: string[] = [];
			PY_STRING.lastIndex = 0;
			let s: RegExpExecArray | null;
			while ((s = PY_STRING.exec(list)) !== null) parts.push(unquote(s[0]));
			if (parts.length) out.push({ source: "argv literal", text: parts.join(" ") });
		} else {
			PY_STRING.lastIndex = 0;
			const argument = region.replace(/^\s*(?:command\s*=\s*)?/, "");
			const s = PY_STRING.exec(argument);
			if (s && s.index === 0) out.push({ source: "string literal", text: unquote(s[0]) });
		}
	}
	return out;
}

export function judgeShellText(text: string, cwd: string): Verdict[] {
	return [
		...judgeSieunPi(text, cwd),
		...judgeSendShell(text, cwd),
		...(text.includes("cua-driver") ? judgeCuaShell(text) : []),
	];
}

export function judgeCell(code: string, cwd: string): Verdict[] {
	return [
		...extractShellCandidates(code).flatMap((candidate) =>
			judgeShellText(candidate.text, cwd).map((v) => ({ ...v, command: `${v.command}  (${candidate.source})` })),
		),
		...judgeSendPython(code),
	];
}

/**
 * One send-log line per send verdict (c37): refused when it is still in `left`, allowed when an OWNER_OK lifted it. An allowed ipython cell
 * is left to the kernel's run-time check (send-check.ts), which logs each send as it runs, so one send makes one allowed line.
 */
function recordSends(judged: Verdict[], left: Verdict[], tool: string, text: string, sessionPath: string | undefined): void {
	const token = ownerOkToken(text);
	for (const v of judged) {
		if (v.rule !== "send") continue;
		const refused = left.some((l) => l.rule === "send" && l.command === v.command);
		if (!refused && tool !== "bash") continue;
		recordSend({ decision: refused ? "refused" : "allowed", layer: "tool_call", ...sessionOf(sessionPath), target: v.command, reason: sendReason(v.reason), ownerOk: token });
	}
}

/** A handler error fails open: a bug here must not stop every bash and ipython call on the machine. */
export function onToolCall(event: ToolCallEvent, ctx: Partial<Pick<ExtensionContext, "cwd" | "sessionManager">> | undefined): ToolCallEventResult | undefined {
	let cwd = "?";
	try {
		if (!enabled("GLOBAL_RULES_GUARD")) return undefined;
		if (event.toolName !== "bash" && event.toolName !== "ipython") return undefined;
		cwd = ctx?.cwd ?? process.cwd();
		const input = event.input as Record<string, unknown>;
		const text = event.toolName === "bash" ? input.command : input.code;
		if (typeof text !== "string") return undefined;
		const judged = event.toolName === "bash" ? judgeShellText(text, cwd) : judgeCell(text, cwd);
		const sessionPath = ctx?.sessionManager?.getSessionFile?.() ?? process.env.RLM_SESSION_DIR;
		const verdicts = applyOwnerOk(judged, text);
		for (const v of verdicts) log("guard", `block rule=${v.rule} cwd=${cwd} :: ${v.command}`);
		recordSends(judged, verdicts, event.toolName, text, sessionPath);
		return verdicts.length ? { block: true, reason: verdicts[0].reason } : undefined;
	} catch (err) {
		log("guard", `handler error, failing open cwd=${cwd} :: ${err instanceof Error ? err.stack : String(err)}`);
		return undefined;
	}
}
