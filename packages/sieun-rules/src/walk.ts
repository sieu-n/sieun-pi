import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { Verdict } from "./guard.ts";
import { SHELLS, effective, expandVars, lex, shellScript, stripHeredocs } from "./shell.ts";

/*
 * Global AGENTS.md rule 6, the owner's rule: never walk all of home or the wiki content root. The text did not hold (c81). On 10-23 a job's
 * recursive glob of all of /home/sieun for a codex auth.json ran 2 h 53 min at 99% CPU. On 11-04 the content root held about 100 GB, 95 GB
 * of it in sessions/, and two wiki jobs walked all of it in one tool call each: 'wiki list numbering fix 11-04' ran a recursive
 * glob.glob of every .html file under the root for 56 min, and 'wiki identical write no-op 11-04' a glob of the same shape for 24 min,
 * when both needed only the curated folders. This rule refuses a find, an rg and a grep -r whose root is home, the wiki content root, or a
 * folder that holds one of them; kernel-walk.py refuses the Python walks. A walk of one named subfolder passes, and so does a find or rg
 * with a max depth of 3 or less: on 11-04 `find ~ -maxdepth 3` listed 175,725 entries in 2.4 s on us-metal02.
 * Hard limit: owner rule 6 says never, and c81's measured repeats show the text did not hold (on 11-04 walks of 56 and 24 min), while a warning would come only after the walk.
 */
// Hard limit: owner rule 6 says never, and c81's measured repeats show the text did not hold (on 11-04 walks of 56 and 24 min).
const PREFIX = "global-rules wiki walk guard:";
export const WALK_TAIL =
	"Owner rule 6: never walk all of home or the wiki content root, which holds about 100 GB of sessions/ and agents/; on 11-04 two wiki " +
	"jobs' recursive globs of it held a pool slot and a CPU for 56 and 24 min. Walk only the folder you need. For wiki pages, ask the wiki " +
	"API: `httpx.get(wiki.base_url() + '/wiki/api/agent/find', params={'glob': 'apps/**'}).json()['results']` lists the pages of one " +
	"curated folder, and `/wiki/api/agent/grep` with `params={'pattern': 'mermaid', 'glob': 'apps/**', 'context': 0}` returns one row per " +
	"matching line with its `path`; run each for apps/**, domains/**, projects/** and experiments/**. On disk on us-metal02, walk one " +
	"curated folder at a time, such as `glob.glob(os.path.expanduser('~/.pi/wiki/content/apps/**/*.html'), recursive=True)` or `rg -l " +
	"mermaid ~/.pi/wiki/content/apps ~/.pi/wiki/content/domains ~/.pi/wiki/content/projects ~/.pi/wiki/content/experiments`. For home, " +
	"name the folder you mean, such as `rg -l x ~/src/sieun-pi` or `find ~/.config -name auth.json`, or list it with `find ~ -maxdepth 3`.";

/** The deepest find or rg that still passes: on 11-04 `find ~ -maxdepth 3` listed 175,725 entries in 2.4 s on us-metal02. */
const SHALLOW = 3;
const HINT = /\b(?:find|rg|grep|egrep|fgrep)\b/;
const MAGIC = /[*?[]/;

/** The wiki content root that ~/.config/sieun-pi/wiki.json names, else ~/.pi/wiki/content. */
function contentRoot(home: string): string {
	try {
		const root = JSON.parse(readFileSync(join(home, ".config", "sieun-pi", "wiki.json"), "utf8")).contentRoot;
		if (typeof root === "string" && root) return real(root.replace(/^~(?=\/|$)/, home));
	} catch {
		// No config: the default root.
	}
	return real(join(home, ".pi", "wiki", "content"));
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

const holds = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);

/** What `path` would walk whole: home (or a folder above it), the wiki content root (or a folder between it and home), or null. */
export function walkRoot(path: string): string | null {
	const home = real(homedir());
	const content = contentRoot(home);
	const at = real(path);
	if (at === content) return `wiki content root ${content}`;
	if (holds(at, home)) return `home ${home}`;
	if (holds(at, content)) return `folder ${at}, which holds the wiki content root ${content}`;
	return null;
}

/** The folder a path word walks: `~` and `$HOME` expanded, and a last `*` or `**` part dropped, since the shell expands it to every child. */
function wordPath(word: string, cwd: string): string | null {
	const home = homedir();
	const expanded = word.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?(?=\/|$)/g, home);
	if (expanded.includes("$")) return null;
	const parts = expanded.split("/");
	const magic = parts.findIndex((part) => MAGIC.test(part));
	if (magic === -1) return resolve(cwd, expanded);
	if (!/^\*{1,2}$/.test(parts[magic])) return null;
	return resolve(cwd, parts.slice(0, magic).join("/") || (expanded.startsWith("/") ? "/" : "."));
}

/** Flags whose value is the next word, and short flags whose value is the rest of a cluster. */
const RG_VALUE = new Set([
	"-A", "-B", "-C", "-e", "-f", "-g", "-m", "-M", "-r", "-t", "-T", "-j", "-d", "-E",
	"--after-context", "--before-context", "--context", "--regexp", "--file", "--glob", "--iglob", "--max-count", "--max-columns",
	"--replace", "--type", "--type-not", "--threads", "--max-depth", "--maxdepth", "--encoding", "--type-add", "--type-clear",
	"--ignore-file", "--sort", "--sortr", "--color", "--colors", "--context-separator", "--field-context-separator",
	"--field-match-separator", "--path-separator", "--max-filesize", "--dfa-size-limit", "--regex-size-limit", "--engine", "--pre",
	"--pre-glob", "--hostname-bin", "--hyperlink-format", "--generate",
]);
const GREP_VALUE = new Set([
	"-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D",
	"--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--include", "--exclude",
	"--exclude-from", "--exclude-dir", "--label", "--color", "--colour", "--binary-files", "--devices", "--directories",
	"--group-separator",
]);

interface Parsed {
	positional: string[];
	flags: Map<string, string>;
}

/** Splits argv into positional words and flags with their values, as rg and GNU grep read them. */
function parse(args: string[], values: Set<string>): Parsed {
	const positional: string[] = [];
	const flags = new Map<string, string>();
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") {
			positional.push(...args.slice(i + 1));
			break;
		}
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq !== -1) flags.set(a.slice(0, eq), a.slice(eq + 1));
			else if (values.has(a)) flags.set(a, args[++i] ?? "");
			else flags.set(a, "");
			continue;
		}
		if (a.startsWith("-") && a.length > 1) {
			for (let k = 1; k < a.length; k++) {
				const flag = `-${a[k]}`;
				if (values.has(flag)) {
					flags.set(flag, k + 1 < a.length ? a.slice(k + 1) : (args[++i] ?? ""));
					break;
				}
				flags.set(flag, "");
			}
			continue;
		}
		positional.push(a);
	}
	return { positional, flags };
}

const shallow = (value: string | undefined): boolean => value !== undefined && /^\d+$/.test(value) && Number(value) <= SHALLOW;

/** The folders a find, rg or grep -r command walks in full, or [] for any other command or a shallow walk. */
function roots(name: string, args: string[], piped: boolean): string[] {
	if (name === "find") {
		let k = 0;
		while (k < args.length && /^-(?:[HLP]|O\d*|D)$/.test(args[k])) k += args[k] === "-D" ? 2 : 1;
		const paths: string[] = [];
		while (k < args.length && !/^[-(!,]/.test(args[k])) paths.push(args[k++]);
		const depth = args.indexOf("-maxdepth");
		if (depth !== -1 && shallow(args[depth + 1])) return [];
		return paths.length ? paths : ["."];
	}
	if (name === "rg") {
		const { positional, flags } = parse(args, RG_VALUE);
		if (shallow(flags.get("--max-depth") ?? flags.get("--maxdepth") ?? flags.get("-d"))) return [];
		const listing = flags.has("--files") || flags.has("--type-list");
		const patterned = listing || flags.has("-e") || flags.has("--regexp") || flags.has("-f") || flags.has("--file");
		const paths = patterned ? positional : positional.slice(1);
		return paths.length ? paths : piped && !listing ? [] : ["."];
	}
	if (name === "grep" || name === "egrep" || name === "fgrep") {
		const { positional, flags } = parse(args, GREP_VALUE);
		const recursive =
			flags.has("-r") || flags.has("-R") || flags.has("--recursive") || flags.has("--dereference-recursive") ||
			flags.get("-d") === "recurse" || flags.get("--directories") === "recurse";
		if (!recursive) return [];
		const patterned = flags.has("-e") || flags.has("--regexp") || flags.has("-f") || flags.has("--file");
		const paths = patterned ? positional : positional.slice(1);
		return paths.length ? paths : ["."];
	}
	return [];
}

function judge(text: string, cwd: string, depth: number, out: Verdict[]): void {
	if (depth > 6) return;
	const clean = stripHeredocs(text);
	const { commands, nested } = lex(clean);
	const piped = /\|/.test(clean.replace(/\|\|/g, ""));
	for (const raw of expandVars(commands)) {
		const eff = effective(raw);
		const name = basename(eff[0] ?? "");
		const args = eff.slice(1);
		if (name === "timeout") {
			const rest = args.filter((a) => !a.startsWith("-"));
			if (rest.length > 1) judge(rest.slice(1).join(" "), cwd, depth + 1, out);
			continue;
		}
		if (SHELLS.has(name)) {
			const script = shellScript(eff);
			if (script) judge(script, cwd, depth + 1, out);
			continue;
		}
		for (const word of roots(name, args, piped)) {
			const path = wordPath(word, cwd);
			const what = path && walkRoot(path);
			if (!what) continue;
			const command = eff.join(" ");
			out.push({ rule: "walk", command, reason: `${PREFIX} \`${command.slice(0, 300)}\` walks the whole ${what}. ${WALK_TAIL}` });
			break;
		}
	}
	for (const inner of nested) judge(inner, cwd, depth + 1, out);
}

/** One verdict per find, rg or grep -r command in `text` that walks all of home or the wiki content root. */
export function judgeWalk(text: string, cwd: string): Verdict[] {
	if (!HINT.test(text)) return [];
	const out: Verdict[] = [];
	judge(text, cwd, 0, out);
	return out;
}
