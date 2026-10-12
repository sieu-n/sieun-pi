import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SHELLS, effective, lex, shellScript, stripHeredocs } from "./shell.ts";
import type { Verdict } from "./guard.ts";

export interface HeavyTree {
	path: string;
	depth: number;
	examples: string[];
}

export interface Grep {
	recursive: boolean;
	pattern: string | null;
	paths: string[];
	carried: string[];
}

const GREPS = new Set(["grep", "egrep", "fgrep", "ggrep"]);
const SHORT_WITH_VALUE = new Set(["e", "f", "m", "A", "B", "C", "d", "D"]);
const LONG_WITH_VALUE = new Set(["--regexp", "--file", "--max-count", "--after-context", "--before-context",
	"--context", "--include", "--exclude", "--exclude-dir", "--exclude-from", "--label", "--binary-files",
	"--devices", "--directories"]);
const RG_FLAGS: Record<string, string> = { i: "-i", l: "-l", w: "-w", F: "-F", c: "-c" };

const quote = (text: string) => (/^[\w./@:=+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);

/** The real path of `path`, or of its nearest existing parent plus the rest. */
export function canonicalDirectory(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		const parent = dirname(absolute);
		return parent === absolute ? absolute : join(canonicalDirectory(parent), relative(parent, absolute));
	}
}

/** Prime's agent folder holds GB of sessions and artifacts. A repo refuses its own heavy trees in its own guard. */
export function heavyTrees(home = homedir()): HeavyTree[] {
	return [{ path: canonicalDirectory(join(home, ".prime/agent")), depth: 0, examples: ["~/.prime/agent/skills"] }];
}

/** Parse grep argv into its recursion flag, pattern, paths, and the rg flags worth carrying over. */
export function parseGrep(eff: string[]): Grep {
	let recursive = false;
	let pattern: string | null = null;
	const positional: string[] = [];
	const carried = new Set<string>(eff[0].endsWith("fgrep") ? ["-F"] : []);
	for (let i = 1; i < eff.length; i++) {
		const word = eff[i];
		if (word === "--") {
			positional.push(...eff.slice(i + 1));
			break;
		}
		if (word.startsWith("--")) {
			const [name, value] = word.split("=", 2);
			const takes = LONG_WITH_VALUE.has(name) && value === undefined;
			const arg = value ?? (takes ? eff[++i] : undefined);
			if (name === "--recursive" || name === "--dereference-recursive") recursive = true;
			if (name === "--directories" && arg === "recurse") recursive = true;
			if (name === "--regexp" && pattern === null) pattern = arg ?? "";
			if (name === "--file") carried.add(`-f ${quote(arg ?? "")}`);
			if (name === "--ignore-case") carried.add("-i");
			if (name === "--files-with-matches") carried.add("-l");
			continue;
		}
		if (word.startsWith("-") && word.length > 1) {
			for (let k = 1; k < word.length; k++) {
				const flag = word[k];
				if (flag === "r" || flag === "R") recursive = true;
				else if (RG_FLAGS[flag]) carried.add(RG_FLAGS[flag]);
				if (SHORT_WITH_VALUE.has(flag)) {
					const arg = k + 1 < word.length ? word.slice(k + 1) : eff[++i];
					if (flag === "d" && arg === "recurse") recursive = true;
					if (flag === "e" && pattern === null) pattern = arg ?? "";
					if (flag === "f") carried.add(`-f ${quote(arg ?? "")}`);
					break;
				}
			}
			continue;
		}
		positional.push(word);
	}
	const usesFile = [...carried].some((flag) => flag.startsWith("-f "));
	if (pattern === null && !usesFile) pattern = positional.shift() ?? "";
	return { recursive, pattern, paths: positional.length ? positional : ["."], carried: [...carried] };
}

function expandPath(word: string, cwd: string, home: string): string | null {
	const expanded = word.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
	if (expanded.includes("$")) return null;
	const glob = expanded.search(/[*?[]/);
	const literal = glob === -1 ? expanded : expanded.slice(0, glob).replace(/[^/]*$/, "");
	return canonicalDirectory(resolve(cwd, literal || "."));
}

function inside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

export function heavyTreeFor(target: string, trees: HeavyTree[]): HeavyTree | null {
	for (const tree of trees) {
		if (inside(tree.path, target)) return tree;
		if (inside(target, tree.path) && relative(tree.path, target).split(sep).length <= tree.depth) return tree;
	}
	return null;
}

function refusal(word: string, pattern: string | null, carried: string[], tree: HeavyTree): string {
	const rg = ["rg", "-n", ...carried, ...(pattern === null ? [] : [quote(pattern)])].join(" ");
	const examples = tree.examples.map((path) => `\`${rg} ${path}\``).join(" or ");
	return (
		`global-rules grep guard: \`grep -r\` over \`${word}\` is refused. That tree holds many GB that grep reads in full, ` +
		"because grep ignores .gitignore; these runs filled the Mac's swap on 2026-10-08. " +
		`Use rg with a narrow path: \`${rg} <narrow path>\`, for example ${examples}. ` +
		"rg skips gitignored files; add -uu to search them inside one narrow folder."
	);
}

function collect(command: string, cwd: string, home: string, trees: HeavyTree[], depth: number, out: Verdict[]): void {
	if (depth > 4) return;
	const { commands, nested } = lex(command);
	let running = cwd;
	for (const argv of commands) {
		const eff = effective(argv);
		if (!eff.length) continue;
		const name = basename(eff[0]);
		if (name === "cd" && eff[1] && !eff[1].startsWith("-")) {
			running = expandPath(eff[1], running, home) ?? running;
			continue;
		}
		if (SHELLS.has(name)) {
			const script = shellScript(eff);
			if (script) collect(script, running, home, trees, depth + 1, out);
			continue;
		}
		if (!GREPS.has(name)) continue;
		const grep = parseGrep(eff);
		if (!grep.recursive) continue;
		for (const word of grep.paths) {
			const target = expandPath(word, running, home);
			const tree = target && heavyTreeFor(target, trees);
			if (tree) {
				out.push({ rule: "grep", command: eff.join(" "), reason: refusal(word, grep.pattern, grep.carried, tree) });
				break;
			}
		}
	}
	for (const inner of nested) collect(inner, running, home, trees, depth + 1, out);
}

export function judgeGrep(text: string, cwd: string, home = homedir()): Verdict[] {
	const out: Verdict[] = [];
	collect(stripHeredocs(text), cwd, home, heavyTrees(home), 0, out);
	return out;
}
