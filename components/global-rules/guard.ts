import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "prime-agent";
import { judgeGrep } from "./grep-guard.ts";
import { enabled, log } from "./log.ts";
import { judgeCuaShell } from "./cua-guard.ts";
import { applyOwnerOk, judgeSendPython, judgeSendShell } from "./send-guard.ts";
import { PY_STRING, balancedSlice } from "./shell.ts";
import { judgeMergePython, judgeMergeShell } from "./merge-guard.ts";
import { judgeSieunPi } from "./sieun-pi.ts";

export interface Verdict {
	rule: "grep" | "sieun-pi" | "send" | "merge";
	command: string;
	reason: string;
	/** What an OWNER_OK todo must name for a merge verdict: the PR, or the repo and default-branch push. */
	subject?: Subject;
}

export interface Subject {
	label: string;
	pattern: RegExp;
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
		...judgeGrep(text, cwd),
		...judgeSieunPi(text, cwd),
		...judgeSendShell(text, cwd),
		...judgeMergeShell(text, cwd),
		...(text.includes("cua-driver") ? judgeCuaShell(text) : []),
	];
}

export function judgeCell(code: string, cwd: string): Verdict[] {
	return [
		...extractShellCandidates(code).flatMap((candidate) =>
			judgeShellText(candidate.text, cwd).map((v) => ({ ...v, command: `${v.command}  (${candidate.source})` })),
		),
		...judgeSendPython(code),
		...judgeMergePython(code),
	];
}

/** A handler error fails open: a bug here must not stop every bash and ipython call on the machine. */
export function onToolCall(event: ToolCallEvent, ctx: Partial<Pick<ExtensionContext, "cwd">> | undefined): ToolCallEventResult | undefined {
	let cwd = "?";
	try {
		if (!enabled("GLOBAL_RULES_GUARD")) return undefined;
		if (event.toolName !== "bash" && event.toolName !== "ipython") return undefined;
		cwd = ctx?.cwd ?? process.cwd();
		const input = event.input as Record<string, unknown>;
		const text = event.toolName === "bash" ? input.command : input.code;
		if (typeof text !== "string") return undefined;
		const verdicts = applyOwnerOk(event.toolName === "bash" ? judgeShellText(text, cwd) : judgeCell(text, cwd), text);
		for (const v of verdicts) log("guard", `block rule=${v.rule} cwd=${cwd} :: ${v.command}`);
		return verdicts.length ? { block: true, reason: verdicts[0].reason } : undefined;
	} catch (err) {
		log("guard", `handler error, failing open cwd=${cwd} :: ${err instanceof Error ? err.stack : String(err)}`);
		return undefined;
	}
}
