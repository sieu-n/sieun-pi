import { policyFor } from "../../policies/index.mjs";
import { findProject } from "../../repo-hooks/project.mjs";
import { faultInject, featureEnabled, log } from "./log.mjs";

const MAX_CODE_BYTES = 200000;

const PY_STRING = /(?:[rbfuRBFU]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
const EXEC_CALL =
	/(?:^|[^\w.])(?:\w+\s*\.\s*)?(?:bash|run|Popen|call|check_call|check_output|getoutput|getstatusoutput|system|popen)\s*\(/g;
const TRIPLE_DOUBLE = '"""';
const TRIPLE_SINGLE = "'''";

function unquote(literal) {
	const body = literal.replace(/^[rbfuRBFU]{0,2}/, "");
	const triple = body.startsWith(TRIPLE_DOUBLE) || body.startsWith(TRIPLE_SINGLE);
	const inner = triple ? body.slice(3, -3) : body.slice(1, -1);
	return inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(['"\\])/g, "$1");
}

function balancedSlice(code, openParen) {
	if (openParen < 0) return "";
	let depth = 0;
	const limit = Math.min(code.length, openParen + 4000);
	for (let i = openParen; i < limit; i++) {
		const ch = code[i];
		if (ch === "'" || ch === '"') {
			const delimiter = code.slice(i, i + 3) === ch.repeat(3) ? ch.repeat(3) : ch;
			i += delimiter.length;
			while (i < code.length && !code.startsWith(delimiter, i)) {
				i += code[i] === "\\" ? 2 : 1;
			}
			i += delimiter.length - 1;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return code.slice(openParen + 1, i);
		}
	}
	return code.slice(openParen + 1, limit);
}

/**
 * A `%%bash` cell is one shell script. Otherwise look for `!` line escapes and
 * for literal calls to bash, subprocess, and os. Computed arguments are
 * outside this static check. See README "Limits and verification".
 */
export function extractShellCandidates(code) {
	const out = [];
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
	let m;
	while ((m = EXEC_CALL.exec(callSites)) !== null) {
		const region = balancedSlice(code, code.indexOf("(", m.index + m[0].length - 1));
		const head = region.replace(/^\s*/, "");
		if (head.startsWith("[")) {
			const listEnd = head.indexOf("]");
			const list = listEnd === -1 ? head : head.slice(0, listEnd);
			const parts = [];
			PY_STRING.lastIndex = 0;
			let s;
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

export function judgeShellText(text, project) {
	return policyFor(project.policy)?.judgeShellText(text, project) ?? [];
}

export function judgeCell(code, project) {
	const verdicts = [];
	for (const candidate of extractShellCandidates(code)) {
		for (const v of judgeShellText(candidate.text, project)) {
			verdicts.push({ ...v, command: `${v.command}  (${candidate.source})` });
		}
	}
	return verdicts;
}

/** @type {import("prime-agent").ExtensionHandler<import("prime-agent").ToolCallEvent, import("prime-agent").ToolCallEventResult>} */
export async function onToolCall(event, ctx) {
	faultInject("git-guard", "outer");
	try {
		faultInject("git-guard", "inner");
		if (!featureEnabled("VIREV_GIT_GUARD")) return undefined;
		if (event.toolName !== "bash" && event.toolName !== "ipython") return undefined;
		const project = findProject(ctx?.cwd ?? process.cwd());
		if (!project || !policyFor(project.policy)) return undefined;

		let verdicts;
		switch (event.toolName) {
			case "bash":
				if (typeof event.input.command !== "string") return undefined;
				verdicts = judgeShellText(event.input.command, project);
				break;
			case "ipython":
				if (typeof event.input.code !== "string") return undefined;
				verdicts = judgeCell(event.input.code, project);
				break;
		}
		for (const v of verdicts) log("git-guard", `${v.level}: ${v.command} :: ${v.reason.slice(0, 160)}`);
		const blocked = verdicts.find((v) => v.level === "block");
		if (blocked) return { block: true, reason: blocked.reason };
		const warned = verdicts.find((v) => v.level === "warn");
		if (warned && ctx?.hasUI) ctx.ui.setStatus("virev-git", `git warn: ${warned.command.slice(0, 60)}`);
		return undefined;
	} catch (err) {
		log("git-guard", `handler error, failing open: ${err instanceof Error ? err.stack : String(err)}`);
		return undefined;
	}
}
