import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { onMac } from "./browser.ts";
import { SHELLS, effective, expandVars, lex, shellScript, stripHeredocs } from "./shell.ts";

/*
 * Global rule 6 keeps heavy compute on us-metal02 and off the owner's Mac. On 11-04 at 16:20:55 KST the job 'onboarding paywall back'
 * (session 01a1a567) ran `pnpm check` in auto-sns-agent apps/search through its kernel's bash() on the Mac: a tsgo run with an 8 GB heap
 * whose process tree grew from 0.1 to 7.52 GB in a minute, while the Mac's swap went from 11.5 to 13.3 GB. Nothing in the Mac's tools
 * named another place to run it. On the Mac this rule notes each whole-project type check or test suite an agent starts: svelte-check,
 * tsc or tsgo with no named file, vitest with no named test, a turbo check or test task, an app's check script such as kit-check.mjs,
 * and a package.json script that runs one of those. The note names the measured cost and the off-Mac command for the repo, and the run
 * goes on: a memory spike guards none of the hard cases of c98, so this is a warning and never a refusal. The kernel half (send-check.ts)
 * prints it when the kernel starts the command, and the tool_call half adds it to a bash tool call's result. Other hosts get no note.
 */
const PREFIX = "Mac heavy check:";
export const HEAVY_COST =
	"Global rule 6 keeps heavy compute on us-metal02: on 11-04 at 16:20:55 KST one job's `pnpm check` in auto-sns-agent apps/search grew " +
	"from 0.1 to 7.52 GB in a minute and pushed the Mac's swap from 11.5 to 13.3 GB.";

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const LAUNCHERS = new Set(["npx", "bunx", "pnpx"]);
const JS_RUNNERS = new Set(["node", "tsx", "bun"]);
const INFO = new Set(["--help", "-h", "--version", "-v", "-V", "--init", "--showConfig", "--listFiles"]);
const TSC_VALUE = /^(?:-p|--project|-t|--target|-m|--module|--lib|--outDir|--outFile|--rootDir|--jsx|--moduleResolution|--declarationDir|--types|--typeRoots|--baseUrl|--tsBuildInfoFile|--generateTrace|--locale|--moduleDetection|--checkers)$/;
const VITEST_VALUE = /^(?:-c|--config|-r|--root|--dir|--project|--reporter|--outputFile|--pool|--maxWorkers|--minWorkers|--environment|--shard|-t|--testNamePattern|--mode|--exclude|--coverage\.\w+|--sequence\.\w+|--testTimeout|--hookTimeout|--retry|--bail)$/;
const VITEST_COMMANDS = new Set(["run", "watch", "dev", "bench"]);
const PNPM_DIR = /^(?:-C|--dir|--prefix|--cwd)$/;
const PNPM_WORKSPACE = /^(?:--filter|-F|--filter-prod)$/;
const TASK = /(?:^|:)(?:check|test|typecheck|svelte-check)(?:$|:)/;
const MAX_SCRIPT_BYTES = 500000;

function readFile(path: string): string | null {
	try {
		const stat = statSync(path);
		return stat.isFile() && stat.size <= MAX_SCRIPT_BYTES ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
}

const at = (cwd: string, file: string): string => resolve(cwd, file.replace(/^~(?=\/|$)/, homedir()));

/** The words that are neither flags nor the values of the flags `valued` names. */
function positionals(args: string[], valued: RegExp): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const w = args[i];
		if (w === "--") continue;
		if (w.startsWith("-")) {
			if (!w.includes("=") && valued.test(w)) i++;
			continue;
		}
		out.push(w);
	}
	return out;
}

/** What a type checker or test runner checks when it names no file, or null when it names one or only prints its version or help. */
function wholeRun(name: string, args: string[]): string | null {
	if (args.some((a) => INFO.has(a))) return null;
	if (name === "svelte-check") return "svelte-check checks the whole workspace";
	if (name === "tsc" || name === "tsgo") {
		if (args.some((a) => a === "-b" || a === "--build")) return `${name} --build checks every project it references`;
		return positionals(args, TSC_VALUE).length ? null : `${name} checks the whole project`;
	}
	if (name === "vitest") {
		const words = positionals(args, VITEST_VALUE);
		if (words[0] === "related" || words[0] === "list" || words[0] === "init") return null;
		return (VITEST_COMMANDS.has(words[0] ?? "") ? words.slice(1) : words).length ? null : "vitest runs every test file";
	}
	if (name === "turbo") {
		const words = positionals(args, /^(?:--filter|-F|--concurrency|--cache-dir|--graph|--output-logs|--log-order|--env-mode)$/);
		if (args.some((a) => a === "--dry" || a === "--dry-run" || a.startsWith("--dry=") || a.startsWith("--graph"))) return null;
		const tasks = words[0] === "run" ? words.slice(1) : words;
		return tasks.some((t) => TASK.test(t)) ? "turbo runs a check or test task across packages" : null;
	}
	return null;
}

/** A check script such as auto-sns-agent's packages/config/kit-check.mjs: a node script named for a check that runs svelte-check, tsc or tsgo. */
function checkScript(args: string[], cwd: string): string | null {
	const file = args.find((a) => !a.startsWith("-"));
	if (!file || !/check/i.test(basename(file))) return null;
	const text = readFile(at(cwd, file));
	return text && /svelte-check|\btsgo\b|\btsc\b/.test(text) ? `${basename(file)} runs a whole-app type check` : null;
}

/** The package.json script a package manager runs, with the folder it runs in, or null. */
function packageScript(name: string, args: string[], cwd: string): { script: string; dir: string; label: string } | { workspace: string } | null {
	let dir = cwd;
	let workspace = false;
	const words: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const [flag, inline] = args[i].split(/=(.*)/s);
		if (PNPM_DIR.test(flag)) {
			const value = inline ?? args[++i];
			if (value) dir = at(dir, value);
			continue;
		}
		if (PNPM_WORKSPACE.test(flag)) {
			if (inline === undefined) i++;
			workspace = true;
			continue;
		}
		if (flag === "-r" || flag === "--recursive" || flag === "-w" || flag === "--workspaces") {
			workspace = true;
			continue;
		}
		if (flag.startsWith("-")) continue;
		words.push(args[i]);
	}
	let script = words[0] === "run" || words[0] === "run-script" ? words[1] : words[0];
	if (name === "npm" && !["run", "run-script", "test", "t"].includes(words[0] ?? "")) return null;
	if (script === "t") script = "test";
	if (!script) return null;
	if (workspace) return TASK.test(script) ? { workspace: script } : null;
	try {
		const scripts = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
		return typeof scripts[script] === "string" ? { script: scripts[script] as string, dir, label: script } : null;
	} catch {
		return null;
	}
}

/**
 * The command as the agent typed it: the words before a redirect's leftover fd number, a closing brace or an assignment, which the lexer
 * keeps from a wrapper such as Prime's bash(), whose `npm test` on the Mac read as "npm test 2 } 8 __prime_status=$?" on 11-04.
 */
function label(eff: string[]): string {
	const end = eff.findIndex((w, i) => i > 0 && (/^\d+$/.test(w) || w === "}" || /^[A-Za-z_]\w*=/.test(w)));
	return (end === -1 ? eff : eff.slice(0, end)).join(" ");
}

interface Hit {
	command: string;
	cwd: string;
	why: string;
}

/**
 * One hit per command in `text` that runs a whole-project check or suite, judged from `start`. `top` is the command the agent typed and
 * where it ran, and `via` names the package scripts it went through.
 */
function judge(text: string, depth: number, out: Hit[], start: string, vars: Map<string, string>, top?: { command: string; cwd: string }, via = ""): void {
	if (depth > 6) return;
	let cwd = start;
	const { commands, nested } = lex(stripHeredocs(text));
	for (const argv of expandVars(commands, vars)) {
		const eff = effective(argv);
		const name = basename(eff[0] ?? "");
		const args = eff.slice(1);
		const at0 = top ?? { command: label(eff), cwd };
		const hit = (why: string): void => { out.push({ ...at0, why: via + why }); };
		const again = (inner: string, where = cwd, through = via): void => judge(inner, depth + 1, out, where, new Map(vars), at0, through);
		if (name === "cd" || name === "pushd") {
			cwd = at(cwd, args.find((a) => !a.startsWith("-")) ?? homedir());
			continue;
		}
		if (SHELLS.has(name)) {
			const script = shellScript(eff);
			if (script) again(script);
			continue;
		}
		if (name === "timeout" || name === "xargs" || name === "heavy") {
			const dash = args.indexOf("--");
			const rest = dash !== -1 ? args.slice(dash + 1) : args.filter((a) => !a.startsWith("-")).slice(name === "xargs" ? 0 : 1);
			if (rest.length) again(rest.join(" "));
			continue;
		}
		if (LAUNCHERS.has(name) || (PACKAGE_MANAGERS.has(name) && ["exec", "dlx", "x"].includes(args[0] ?? ""))) {
			const rest = LAUNCHERS.has(name) ? args : args.slice(1);
			let k = 0;
			while (k < rest.length && rest[k].startsWith("-")) k += /^(?:-p|--package)$/.test(rest[k]) ? 2 : 1;
			if (rest[k]) again(rest.slice(k).join(" "));
			continue;
		}
		if (PACKAGE_MANAGERS.has(name)) {
			const found = packageScript(name, args, cwd);
			if (found && "workspace" in found) hit(`it runs the \`${found.workspace}\` script across workspace packages`);
			else if (found) again(found.script, found.dir, `${via}its \`${found.label}\` script runs \`${found.script.slice(0, 200)}\`, and `);
			else if ((name === "pnpm" || name === "yarn") && args[0] && args[0] !== "run" && !args[0].startsWith("-")) again(args.join(" "));
			continue;
		}
		const why = JS_RUNNERS.has(name) ? checkScript(args, cwd) : wholeRun(name.replace(/\.(?:c|m)?js$/, ""), args);
		if (why) hit(why);
	}
	for (const inner of nested) judge(inner, depth + 1, out, cwd, new Map(vars), top, via);
}

/** The git checkout that holds `dir`, or null. */
function checkoutOf(dir: string): string | null {
	for (let d = resolve(dir); ; d = dirname(d)) {
		if (existsSync(join(d, ".git"))) return d;
		if (dirname(d) === d) return null;
	}
}

/** Where this command runs off the Mac, for the checkout that holds `cwd`. */
export function offMac(command: string, cwd: string): string {
	const root = checkoutOf(cwd);
	const sub = root ? relative(root, resolve(cwd)) : "";
	if (root && existsSync(join(root, "scripts/repo/agent/commit.mjs"))) {
		return "In auto-sns-agent, `node scripts/repo/agent/commit.mjs --probe <files>` from the checkout root runs it in CI on your " +
			"uncommitted files, and verify-dev runs it on every push of your commit; on the Mac run only the named-file checks of " +
			".agents/skills/repo/verify/SKILL.md, such as `node_modules/.bin/vitest run <test file>`.";
	}
	if (root && existsSync(join(root, "packages/sieun-rules"))) {
		return "In sieun-pi, push your commit to main, which prime-sync brings to us-metal02's ~/src/sieun-pi within a minute, then run " +
			`\`ssh us-metal02 'cd ~/src/sieun-pi${sub ? `/${sub}` : ""} && git log -1 --format=%h && heavy 8G -- ${command.slice(0, 200)}'\`; ` +
			"on the Mac run only the test files you changed, by name.";
	}
	return "Push your branch and run it on us-metal02 in that repo's checkout of the pushed commit as `heavy 8G -- " + command.slice(0, 200) +
		"`, or let CI run it; on the Mac run only the files you changed, by name.";
}

/** On the owner's Mac, one note per command in `text` that runs a whole-project type check or test suite; elsewhere none. */
export function judgeHeavyCheck(text: string, cwd: string): string[] {
	if (!onMac()) return [];
	const hits: Hit[] = [];
	judge(text, 0, hits, cwd, new Map());
	const seen = new Set<string>();
	return hits.filter((h) => !seen.has(h.command) && seen.add(h.command)).map((h) =>
		`${PREFIX} \`${h.command.slice(0, 200)}\` runs here on the owner's Mac, because ${h.why}. It runs now. ${HEAVY_COST} ` +
		`Next time run it off the Mac. ${offMac(h.command, h.cwd)}`);
}
