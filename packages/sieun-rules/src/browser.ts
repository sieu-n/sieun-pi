import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Verdict } from "./guard.ts";
import { SHELLS, effective, expandVars, lex, shellScript, stripHeredocs } from "./shell.ts";

/*
 * Owner c177, 10-27: "can you remove Headless browser???? NEVER put it back in. we'll always use Aside only." Owner c103: no job opens a
 * window or a browser on his MacBook Pro while he uses it. The pre-commit hook scripts/git-hooks/no-headless.mjs only scans files committed
 * to this repo, so on 10-28 at 02:18:31Z the 'staging timings' job (session 01a1801b) copied its scripts to /tmp/timings-mac on the Mac,
 * ran `cd /tmp/timings-mac && RUNS=1 node scout.mjs` through the kernel's bash(), and its chromium.launch({ headless: true }) started
 * Chrome for Testing pid 9679 there. On the Mac this rule refuses a command that would launch a Playwright or Puppeteer browser: a script
 * a runner starts (node, tsx, bun, deno, python, uv run, npx), read with the local files it imports, a `playwright test` or other browser
 * subcommand of the Playwright CLI, and a package.json script that runs one of those. Every other host is left alone, so repo specs keep
 * running on us-metal02 and in CI (c163). The kernel half (send-check.ts) judges the same rule on each subprocess the kernel starts.
 */
const PREFIX = "global-rules browser guard:";
export const BROWSER_TAIL =
	"The owner uses this Mac, agents browse only through Aside (c177, 10-27: \"we'll always use Aside only\"), and no job starts a " +
	"browser or a window on it (c103); on 10-28 a job's `node scout.mjs` started Chrome for Testing here anyway. Open the page in a " +
	"background tab of his Aside with the aside_browser skill, or run the script on us-metal02, where aside_browser opens pages that need " +
	"no login in that box's own Chrome; repo Playwright specs run on us-metal02 and in CI (c163).";

const JS_RUNNERS = new Set(["node", "tsx", "ts-node", "bun", "deno"]);
const PY_RUNNER = /^python(?:\d+(?:\.\d+)*)?$/;
const LAUNCHERS = new Set(["npx", "bunx", "pnpx"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Playwright CLI subcommands that start a browser or open one on the screen; install, uninstall and --version start none. */
const PW_BROWSER_COMMANDS = new Set(["test", "screenshot", "pdf", "open", "codegen", "cr", "ff", "wk", "show-trace", "show-report"]);
const NODE_VALUE_FLAGS = /^(?:--import|--require|-r|--loader|--experimental-loader|--env-file|--conditions|-C|--input-type|--test-reporter|--test-reporter-destination|--tsconfig)$/;
const UV_VALUE_FLAGS = /^(?:--with|--with-requirements|--project|--directory|-p|--python|--env-file|--package|--group|--extra|--index|--index-url)$/;
/** A Playwright or Puppeteer module name or path in quotes, so `createRequire(...)("playwright")` and an import of node_modules/playwright/index.mjs count too. */
const JS_LIBRARY = /["'`](?:[^"'`\n]*\/)?(?:@playwright\/test|playwright(?:-core|-chromium|-firefox|-webkit)?|puppeteer(?:-core|-extra)?|patchright(?:-core)?)(?:\/[^"'`\n]*)?["'`]/;
const PY_LIBRARY = /^\s*(?:from|import)\s+(?:playwright|pyppeteer|patchright)\b/m;
const LAUNCH = /\.\s*(?:launch|launchPersistentContext|launchServer|launch_persistent_context|launch_server)\s*\(/;
const JS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const PY_IMPORT = /^\s*(?:from\s+(\.?[\w.]+)\s+import|import\s+([\w.]+))/gm;
const JS_EXTENSIONS = ["", ".ts", ".mts", ".cts", ".mjs", ".js", ".cjs", "/index.ts", "/index.mjs", "/index.js"];
const MAX_SCRIPT_BYTES = 500000;
const MAX_FILES = 40;

/** Whether this guard runs on the owner's Mac. GLOBAL_RULES_PLATFORM stands in for process.platform in tests. */
export function onMac(): boolean {
	return (process.env.GLOBAL_RULES_PLATFORM || process.platform) === "darwin";
}

function readFile(path: string): string | null {
	try {
		const stat = statSync(path);
		return stat.isFile() && stat.size <= MAX_SCRIPT_BYTES ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
}

const at = (cwd: string, file: string): string => resolve(cwd, file.replace(/^~(?=\/|$)/, homedir()));

/** The files a script runs: the script and the local files it imports, up to MAX_FILES. */
function scriptGraph(entry: string, kind: "js" | "py"): string[] {
	const texts: string[] = [];
	const seen = new Set<string>();
	const queue = [entry];
	while (queue.length && seen.size < MAX_FILES) {
		const path = queue.shift()!;
		if (seen.has(path)) continue;
		seen.add(path);
		const text = readFile(path);
		if (text === null) continue;
		texts.push(text);
		const dir = dirname(path);
		if (kind === "js") {
			for (const m of text.matchAll(JS_IMPORT)) {
				const base = resolve(dir, m[1]);
				const stems = [base, base.replace(/\.(?:m|c)?js$/, "")];
				const found = stems.flatMap((stem) => JS_EXTENSIONS.map((ext) => stem + ext)).find((p) => readFile(p) !== null);
				if (found) queue.push(found);
			}
		} else {
			for (const m of text.matchAll(PY_IMPORT)) {
				const name = (m[1] ?? m[2]).replace(/^\./, "").replace(/\./g, "/");
				for (const p of [join(dir, `${name}.py`), join(dir, name, "__init__.py")]) if (readFile(p) !== null) queue.push(p);
			}
		}
	}
	return texts;
}

/** What in this code launches a browser, or null. */
function codeLaunches(texts: string[], kind: "js" | "py"): string | null {
	const library = kind === "js" ? JS_LIBRARY : PY_LIBRARY;
	if (!texts.some((t) => library.test(t)) || !texts.some((t) => LAUNCH.test(t))) return null;
	return kind === "js" ? "it imports Playwright or Puppeteer and calls a browser launch" : "it imports Playwright and calls a browser launch";
}

/** What a script runner's code launches: its inline code (`node -e`, `python -c`) or the script it runs with its local imports. */
function runnerLaunches(name: string, args: string[], cwd: string): string | null {
	const kind = PY_RUNNER.test(name) ? "py" : "js";
	const inline = args.findIndex((a) => (kind === "py" ? a === "-c" : /^(?:-e|--eval|-p|--print)$/.test(a)));
	if (inline !== -1) return codeLaunches([args[inline + 1] ?? ""], kind);
	if (kind === "py") {
		const module = args.indexOf("-m");
		if (module !== -1) return args[module + 1] === "playwright" ? playwrightCli(args.slice(module + 2)) : null;
	}
	let k = 0;
	while (k < args.length && (args[k].startsWith("-") || (kind === "js" && ["run", "x"].includes(args[k])))) k += NODE_VALUE_FLAGS.test(args[k]) ? 2 : 1;
	const file = args[k];
	if (!file) return null;
	return codeLaunches(scriptGraph(at(cwd, file), kind), kind);
}

function playwrightCli(args: string[]): string | null {
	const sub = args.find((a) => !a.startsWith("-"));
	return sub && PW_BROWSER_COMMANDS.has(sub) ? `\`playwright ${sub}\` starts a browser` : null;
}

/** The package.json script a package manager runs (`npm run x`, `pnpm x`, `yarn x`, `npm test`), or null. */
function packageScript(name: string, args: string[], cwd: string): string | null {
	const words = args.filter((a) => !a.startsWith("-"));
	let script = words[0] === "run" || words[0] === "run-script" ? words[1] : words[0];
	if (name === "npm" && !["run", "run-script", "test", "t", "start"].includes(words[0] ?? "")) return null;
	if (script === "t") script = "test";
	if (!script) return null;
	try {
		const scripts = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
		return typeof scripts[script] === "string" ? scripts[script] : null;
	} catch {
		return null;
	}
}

function judge(text: string, depth: number, out: Verdict[], start: string, vars: Map<string, string>): void {
	if (depth > 6) return;
	let cwd = start;
	const { commands, nested } = lex(stripHeredocs(text));
	for (const argv of expandVars(commands, vars)) {
		const eff = effective(argv);
		const name = basename(eff[0] ?? "");
		const args = eff.slice(1);
		const push = (what: string): void => {
			out.push({ rule: "browser", command: eff.join(" "), reason: `${PREFIX} \`${eff.join(" ").slice(0, 300)}\` launches a browser on the owner's Mac: ${what}. ${BROWSER_TAIL}` });
		};
		if (name === "cd" || name === "pushd") {
			cwd = at(cwd, args.find((a) => !a.startsWith("-")) ?? homedir());
			continue;
		}
		let what: string | null = null;
		if (SHELLS.has(name)) {
			const script = shellScript(eff) ?? (args[0] && !args[0].startsWith("-") ? readFile(at(cwd, args[0])) : null);
			if (script) judge(script, depth + 1, out, cwd, new Map(vars));
			continue;
		}
		if (name === "timeout" || name === "xargs") {
			const rest = args.filter((a) => !a.startsWith("-"));
			const inner = name === "xargs" ? rest : rest.slice(1);
			if (inner.length) judge(inner.join(" "), depth + 1, out, cwd, new Map(vars));
			continue;
		}
		if (name === "uv" && args[0] === "run") {
			let k = 1;
			while (k < args.length && args[k].startsWith("-")) k += UV_VALUE_FLAGS.test(args[k]) ? 2 : 1;
			const rest = args.slice(k);
			if (rest.length) judge((rest[0].endsWith(".py") ? ["python", ...rest] : rest).join(" "), depth + 1, out, cwd, new Map(vars));
			continue;
		}
		if (LAUNCHERS.has(name) || (PACKAGE_MANAGERS.has(name) && ["exec", "dlx", "x"].includes(args[0] ?? ""))) {
			const rest = LAUNCHERS.has(name) ? args : args.slice(1);
			let k = 0;
			while (k < rest.length && rest[k].startsWith("-")) k += /^(?:-p|--package)$/.test(rest[k]) ? 2 : 1;
			if (rest[k]) judge(rest.slice(k).join(" "), depth + 1, out, cwd, new Map(vars));
			continue;
		}
		if (name === "playwright") what = playwrightCli(args);
		else if (JS_RUNNERS.has(name) || PY_RUNNER.test(name)) what = runnerLaunches(name, args, cwd);
		else if (PACKAGE_MANAGERS.has(name)) {
			const script = packageScript(name, args, cwd);
			// pnpm and yarn run a package's bin when no script has that name, as `pnpm playwright test` does.
			if (script) judge(script, depth + 1, out, cwd, new Map(vars));
			else if ((name === "pnpm" || name === "yarn") && args[0] && args[0] !== "run") judge(args.join(" "), depth + 1, out, cwd, new Map(vars));
			continue;
		}
		if (what) push(what);
	}
	for (const inner of nested) judge(inner, depth + 1, out, cwd, new Map(vars));
}

/** On the owner's Mac, one verdict per command in `text` that launches a Playwright or Puppeteer browser; elsewhere none. */
export function judgeBrowser(text: string, cwd: string): Verdict[] {
	if (!onMac()) return [];
	const out: Verdict[] = [];
	judge(text, 0, out, cwd, new Map());
	return out;
}
