import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "prime-agent";

/*
 * Loads a repo's .claude/rules/*.md the way Claude Code does. A rule with no `paths:` front matter loads at session start, and a
 * rule with `paths:` globs loads the first time the session reads or edits a file they match. Prime only loads AGENTS.md, so
 * before this no Prime session saw auto-sns-agent's 25 rule files, testing-rules.md included.
 *
 * Cache: the session cwd's unscoped rules go in one message that the `context` hook puts first on every model call, the same
 * text each time, so the cached prefix holds on every turn kind and after a compaction. A scoped rule, or an unscoped rule of
 * another repo the session touches, is appended to the tool result that touched it, so earlier context never changes.
 */

export const CUSTOM_TYPE = "claude-rules";

export interface Rule {
	file: string;
	paths: RegExp[] | null;
	globs: string[];
	body: string;
}

/** The `paths:` globs of a rule's front matter, as a list or one string, and the body after it. */
export function parseRule(file: string, text: string): Rule {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	const body = (match ? text.slice(match[0].length) : text).trim();
	const globs: string[] = [];
	let found = false;
	if (match) {
		const lines = match[1]!.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const head = lines[i]!.match(/^paths\s*:\s*(.*)$/);
			if (!head) continue;
			found = true;
			const inline = head[1]!.trim();
			if (inline) globs.push(...splitGlobs(inline.replace(/^\[([\s\S]*)\]$/, "$1")));
			else for (let j = i + 1; j < lines.length && /^\s*(-|$)/.test(lines[j]!); j++) globs.push(lines[j]!.replace(/^\s*-?\s*/, ""));
		}
	}
	const clean = globs.map((g) => g.trim().replace(/^(['"])(.*)\1$/, "$2")).filter(Boolean);
	return { file, globs: clean, paths: found && clean.length ? clean.map(globRegex) : null, body };
}

/** A comma-separated glob list, cut only at commas outside `{...}`. */
function splitGlobs(list: string): string[] {
	const out = [""];
	let braces = 0;
	for (const ch of list) {
		if (ch === "," && !braces) out.push("");
		else {
			if (ch === "{") braces++;
			if (ch === "}" && braces) braces--;
			out[out.length - 1] += ch;
		}
	}
	return out;
}

/** A glob as Claude Code reads it: `**` spans folders, `*` and `?` stay in one, `{a,b}` picks one. */
export function globRegex(glob: string): RegExp {
	let out = "";
	let braces = 0;
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i]!;
		if (ch === "*" && glob[i + 1] === "*") {
			const slash = glob[i + 2] === "/";
			out += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (ch === "*") out += "[^/]*";
		else if (ch === "?") out += "[^/]";
		else if (ch === "{") {
			braces++;
			out += "(?:";
		} else if (ch === "}" && braces) {
			braces--;
			out += ")";
		} else if (ch === "," && braces) out += "|";
		else out += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
	}
	try {
		return new RegExp(`^${out}$`);
	} catch {
		return /(?!)/;
	}
}

/** Every .md file under <root>/.claude/rules, subfolders and links included, in path order. */
export function readRules(root: string): Rule[] {
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const stat = statSync(path, { throwIfNoEntry: false });
			if (stat?.isDirectory()) walk(path);
			else if (stat?.isFile() && name.endsWith(".md")) files.push(path);
		}
	};
	walk(join(root, ".claude", "rules"));
	return files.map((file) => parseRule(file, readFileSync(file, "utf8")));
}

export function render(rule: Rule): string {
	const scope = rule.paths ? `, loaded because this session touched a file matching ${rule.globs.join(", ")}` : "";
	return `Contents of ${rule.file} (project rule from .claude/rules${scope}). Follow it:\n\n${rule.body}`;
}

/** Paths a command or cell names: words with a slash, read against the folder they run in. */
export function namedPaths(text: string, cwd: string): string[] {
	const out = new Set<string>();
	for (const found of text.matchAll(/(?:~|\$HOME)?[\w.@+\-/]*\/[\w.@+\-/]*/g)) {
		if (text[found.index - 1] === ":") continue;
		const path = found[0].replace(/^(?:~|\$HOME)(?=\/)/, homedir()).replace(/\/+$/, "");
		if (!/\w/.test(path)) continue;
		out.add(isAbsolute(path) ? resolve(path) : resolve(cwd, path));
	}
	return [...out];
}

type CellSteps = (code: string, start: string) => { code: string; cwd: string }[];
export interface KernelCwd {
	cellStart(ctx: unknown): string;
	cellSteps: CellSteps;
}

type Input = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The files a tool call reads, edits or names, with an ipython cell read part by part in the cwd each part runs in. */
export function touchedPaths(toolName: string, input: Input, sessionCwd: string, kernel: KernelCwd, ctx: unknown): string[] {
	const paths: string[] = [];
	for (const key of ["path", "file_path"]) {
		const value = text(input[key]);
		if (value) paths.push(resolve(sessionCwd, value.replace(/^~(?=\/)/, homedir())));
	}
	const code = text(input.code);
	if (toolName === "ipython" && code) for (const step of kernel.cellSteps(code, kernel.cellStart(ctx))) paths.push(...namedPaths(step.code, step.cwd));
	const command = text(input.command);
	if (command) paths.push(...namedPaths(command, sessionCwd));
	return paths;
}

type Entry = { type?: string; customType?: string; data?: unknown };
type Ctx = { cwd?: string; sessionManager?: { getBranch?(): Entry[] } };

/** One session's rules: the start-up message, and which appended rules its context still holds. */
export class SessionRules {
	private roots = new Map<string, string | null>();
	private rules = new Map<string, Rule[]>();
	private prefix: { cwd: string; text: string | null; files: Set<string> } | null = null;
	private appended: Set<string> | null = null;
	private kernel: KernelCwd;

	constructor(kernel: KernelCwd) {
		this.kernel = kernel;
	}

	/** The nearest folder at or above `dir` that holds .claude/rules. */
	rootOf(dir: string): string | null {
		const seen: string[] = [];
		let root: string | null = null;
		for (let at = dir; ; at = dirname(at)) {
			const known = this.roots.get(at);
			if (known !== undefined) {
				root = known;
				break;
			}
			seen.push(at);
			if (statSync(join(at, ".claude", "rules"), { throwIfNoEntry: false })?.isDirectory()) {
				root = at;
				break;
			}
			if (dirname(at) === at) break;
		}
		for (const at of seen) this.roots.set(at, root);
		return root;
	}

	rulesOf(root: string): Rule[] {
		let rules = this.rules.get(root);
		if (!rules) this.rules.set(root, (rules = readRules(root)));
		return rules;
	}

	/** The unscoped rules of the session cwd's repo, read once so the text stays the same for the whole session. */
	startup(cwd: string): { text: string | null; files: Set<string> } {
		if (this.prefix?.cwd === cwd) return this.prefix;
		const root = this.rootOf(cwd);
		const always = root ? this.rulesOf(root).filter((rule) => !rule.paths) : [];
		this.prefix = {
			cwd,
			text: always.length ? `Project rules from ${join(root!, ".claude", "rules")} that apply to all work in this repo:\n\n${always.map(render).join("\n\n")}` : null,
			files: new Set(always.map((rule) => rule.file)),
		};
		return this.prefix;
	}

	/** The rules appended since the last compaction, rebuilt from the session's entries after a reload, resume or fork. */
	appendedSet(ctx: Ctx): Set<string> {
		if (this.appended) return this.appended;
		const set = new Set<string>();
		for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
			if (entry.type === "compaction") set.clear();
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) for (const file of (entry.data as { files?: string[] })?.files ?? []) set.add(file);
		}
		return (this.appended = set);
	}

	compacted(): void {
		this.appended = new Set();
	}

	/** Rules a tool call's paths bring in that the context does not hold yet. */
	newRules(toolName: string, input: Input, ctx: Ctx): Rule[] {
		const cwd = ctx.cwd ?? process.cwd();
		const start = this.startup(cwd).files;
		const appended = this.appendedSet(ctx);
		const out = new Map<string, Rule>();
		for (const path of touchedPaths(toolName, input, cwd, this.kernel, ctx)) {
			const root = this.rootOf(dirname(path));
			if (!root) continue;
			const rel = relative(root, path).split(sep).join("/");
			if (!rel || rel.startsWith("..")) continue;
			for (const rule of this.rulesOf(root)) {
				if (start.has(rule.file) || appended.has(rule.file) || out.has(rule.file)) continue;
				if (!rule.paths || rule.paths.some((re) => re.test(rel))) out.set(rule.file, rule);
			}
		}
		for (const file of out.keys()) appended.add(file);
		return [...out.values()];
	}
}

export function register(pi: Pick<ExtensionAPI, "on" | "appendEntry">, kernel: KernelCwd): void {
	const session = new SessionRules(kernel);
	pi.on("context", (event, ctx) => {
		let text: string | null;
		try {
			text = session.startup((ctx as Ctx).cwd ?? process.cwd()).text;
		} catch {
			return undefined;
		}
		if (!text) return undefined;
		return { messages: [{ role: "custom", customType: CUSTOM_TYPE, content: text, display: false, timestamp: 0 } as never, ...event.messages] };
	});
	pi.on("tool_result", (event, ctx) => {
		let rules: Rule[];
		try {
			rules = session.newRules(event.toolName, event.input, ctx as Ctx);
		} catch {
			return undefined;
		}
		if (!rules.length) return undefined;
		pi.appendEntry(CUSTOM_TYPE, { files: rules.map((rule) => rule.file) });
		return { content: [...event.content, { type: "text", text: rules.map(render).join("\n\n") }] };
	});
	pi.on("session_compact", () => session.compacted());
}
