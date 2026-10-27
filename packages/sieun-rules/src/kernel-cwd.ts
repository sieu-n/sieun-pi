import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { sessionDirOf } from "./paths.ts";
import { PY_STRING, balancedSlice } from "./shell.ts";

/*
 * Where an ipython cell's commands really run. Prime gives the tool_call guard only ctx.cwd, the cwd the session started in, and a
 * cell runs wherever the kernel's last os.chdir left it. kernel-cwd.py, which the prelude loads once per kernel, writes
 * {"pid", "host", "cwd"} to <RLM_SESSION_DIR>/kernel-cwd.json at load and after each os.chdir, so the guard reads the kernel's
 * real cwd before a cell runs. On 10-19 a replay of the box's last 24 h found git commits in prime-agent, sieun-pi and scratch
 * repos judged as if they ran in auto-sns-agent's checkout, because their session had started there.
 */
export const KERNEL_CWD_FILE = "kernel-cwd.json";

/** A cell part and the cwd its commands run in. */
export interface CellStep {
	code: string;
	cwd: string;
}

export { sessionDirOf };

/** The cwd the session's live kernel last reported, or null when there is no report, its kernel is gone or it came from another host. */
export function kernelCwd(sessionFile: string | null | undefined): string | null {
	const dir = sessionDirOf(sessionFile);
	if (!dir) return null;
	try {
		const report = JSON.parse(readFileSync(join(dir, KERNEL_CWD_FILE), "utf8")) as { pid?: unknown; host?: unknown; cwd?: unknown };
		if (typeof report.cwd !== "string" || typeof report.pid !== "number" || report.host !== hostname()) return null;
		process.kill(report.pid, 0);
		return report.cwd;
	} catch {
		return null;
	}
}

type CtxLike = { cwd?: string; sessionManager?: { getSessionFile?(): string | null | undefined } } | null | undefined;

/** Where an ipython cell starts: the kernel's reported cwd, else ctx.cwd, else this process's cwd. A stale ctx throws on every read. */
export function cellStart(ctx: unknown): string {
	const read = <T>(get: () => T): T | undefined => {
		try {
			return get() ?? undefined;
		} catch {
			return undefined;
		}
	};
	const c = ctx as CtxLike;
	return kernelCwd(read(() => c?.sessionManager?.getSessionFile?.())) ?? read(() => c?.cwd) ?? process.cwd();
}

const expandHome = (p: string) => p.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
const blank = (text: string) => text.replace(new RegExp(`${PY_STRING.source}|#[^\n]*`, "g"), (s) => " ".repeat(s.length));
const STRING_ONLY = new RegExp(`^${PY_STRING.source}$`);
const WRAPPER = /^(?:os\s*\.\s*path\s*\.\s*(?:expanduser|abspath|realpath|normpath)|str|(?:pathlib\s*\.\s*)?Path|os\s*\.\s*fspath)\s*\(([\s\S]*)\)$/;
const METHOD = /^([\s\S]+)\.\s*(?:expanduser|resolve|absolute)\s*\(\s*\)$/;
const JOIN = /^os\s*\.\s*path\s*\.\s*join\s*\(([\s\S]*)\)$/;

/** `text` cut at the `seps` characters outside strings and brackets, with the separator before each later part. */
function splitTop(text: string, seps: string): { parts: string[]; ops: string[] } {
	const sites = blank(text);
	const parts: string[] = [];
	const ops: string[] = [];
	let depth = 0;
	let last = 0;
	for (let i = 0; i < sites.length; i++) {
		const ch = sites[i];
		if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) depth--;
		else if (depth === 0 && seps.includes(ch)) {
			parts.push(text.slice(last, i));
			ops.push(ch);
			last = i + 1;
		}
	}
	parts.push(text.slice(last));
	return { parts, ops };
}

/** The literal a Python string spells, with an f-string's {name} parts filled from `names`, or null when one is unknown. */
function stringValue(text: string, names: Map<string, string | null>): string | null {
	const prefix = text.match(/^[rbfuRBFU]{0,2}/)![0];
	const quoted = text.slice(prefix.length);
	const body = /^("{3}|'{3})/.test(quoted) ? quoted.slice(3, -3) : quoted.slice(1, -1);
	if (!/f/i.test(prefix)) return /r/i.test(prefix) ? body : body.replace(/\\(['"\\])/g, "$1");
	let unknown = false;
	const filled = body.replace(/\{([^{}]*)\}/g, (_whole, inner: string) => {
		const value = pathValue(inner, names);
		if (value === null) unknown = true;
		return value ?? "";
	});
	return unknown ? null : filled;
}

/** The value of a path expression the cell spells out: a string, an f-string or a name it set, through Path, expanduser, os.path.join, + and /. */
export function pathValue(expr: string, names: Map<string, string | null>): string | null {
	const text = expr.trim();
	if (!text) return null;
	if (STRING_ONLY.test(text)) return stringValue(text, names);
	if (/^[A-Za-z_]\w*$/.test(text)) return names.get(text) ?? null;
	const sum = splitTop(text, "+/");
	if (sum.parts.length > 1) {
		const values = sum.parts.map((part) => pathValue(part, names));
		if (values.some((v) => v === null)) return null;
		return (values as string[]).reduce((acc, value, i) => (sum.ops[i - 1] === "/" ? join(acc, value) : acc + value));
	}
	const joined = text.match(JOIN);
	if (joined) {
		const values = splitTop(joined[1], ",").parts.filter((p) => p.trim()).map((part) => pathValue(part, names));
		return values.length && values.every((v) => v !== null) ? join(...(values as string[])) : null;
	}
	const wrapped = text.match(METHOD) ?? text.match(WRAPPER);
	if (wrapped) {
		const value = pathValue(splitTop(wrapped[1], ",").parts[0] ?? "", names);
		return value === null ? null : expandHome(value);
	}
	return null;
}

const CHDIR = /\bos\s*\.\s*chdir\s*\(/g;
const ASSIGN = /^[ \t]*([A-Za-z_]\w*)[ \t]*=(?!=)/gm;
/** A shell `cd`, `git -C`, `--git-dir` or `--work-tree` whose path starts with an f-string placeholder. */
const TARGET_HOLE = /(\bcd\s+|\s-C\s*|--git-dir[=\s]\s*|--work-tree[=\s]\s*)(["']?)\{([^{}]+)\}/g;

/**
 * The cwd of commands after an os.chdir to a path this cell cannot spell, such as a name an earlier cell set. It lies in no repo,
 * so no tool_call rule judges those commands by cwd, and kernel-guard.py judges their git writes at run time with the real cwd.
 */
export const UNKNOWN_CWD = "/nonexistent/global-rules-unknown-cwd";

/** Fills each f-string placeholder that names a cd or git -C target with its value, or UNKNOWN_CWD when the cell cannot spell it. */
function fillTargets(code: string, names: Map<string, string | null>): string {
	return code.replace(new RegExp(PY_STRING.source, "g"), (literal) => {
		if (!/^[rR]?[fF]/.test(literal)) return literal;
		return literal.replace(TARGET_HOLE, (_whole, lead: string, quote: string, inner: string) => {
			const value = pathValue(inner, names);
			return `${lead}${quote}${value === null || /[{}'"\\]/.test(value) ? UNKNOWN_CWD : value}`;
		});
	});
}

/**
 * The cell cut at each os.chdir, each part with the cwd its commands run in. A chdir to a path the cell spells out moves the cwd,
 * and one it cannot spell moves it to UNKNOWN_CWD. `names` holds the values of names set before this cell, when the caller knows them.
 */
export function cellSteps(code: string, start: string, names: Map<string, string | null> = new Map()): CellStep[] {
	const sites = blank(code);
	const events: { at: number; name?: string; expr: string }[] = [];
	ASSIGN.lastIndex = 0;
	for (let m: RegExpExecArray | null; (m = ASSIGN.exec(sites)) !== null; ) {
		const from = m.index + m[0].length;
		const rest = sites.slice(from).search(/[;\n]/);
		events.push({ at: m.index, name: m[1], expr: code.slice(from, rest === -1 ? code.length : from + rest) });
	}
	CHDIR.lastIndex = 0;
	for (let m: RegExpExecArray | null; (m = CHDIR.exec(sites)) !== null; ) {
		if (m.index > 0 && /[\w.]/.test(sites[m.index - 1])) continue;
		events.push({ at: m.index, expr: balancedSlice(code, m.index + m[0].length - 1) });
	}
	events.sort((a, b) => a.at - b.at);
	const steps: CellStep[] = [];
	let cwd = start;
	let from = 0;
	for (const event of events) {
		if (event.name !== undefined) {
			names.set(event.name, pathValue(event.expr, names));
			continue;
		}
		steps.push({ code: fillTargets(code.slice(from, event.at), names), cwd });
		const value = pathValue(event.expr, names);
		cwd = value === null ? UNKNOWN_CWD : resolve(cwd, expandHome(value));
		from = event.at;
	}
	steps.push({ code: fillTargets(code.slice(from), names), cwd });
	return steps.filter((step, i) => i === steps.length - 1 || step.code.trim());
}
