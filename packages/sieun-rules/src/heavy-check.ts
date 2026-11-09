import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
 * prints it when the kernel starts the command, and the tool_call half adds it to a bash tool call's result. On another host only a command
 * sent to the Mac over ssh gets the note: on 11-08 at 11:11Z the job 'staging design fix 11-08' (session 01a1bad2) ran virev-demo's
 * kit-check.mjs with an 8 GB heap on the Mac from its us-metal02 kernel as `ssh mac '... nohup sh -c ...'`, and at 11:12:30Z that tree
 * held 5.17 GB while the Mac swapped out 10,686 pages/s, with no note, because the check ran on the Mac while the kernel ran on the box.
 * It notes `vercel inspect` the same way: on 11-06 at 18:30:10Z one started by the chat 'sep launch!! (product guy)' reached 4.41 GB within
 * 20 s while the Mac swapped out 6,868.7 pages/s, and its note names vercel-deployment.sh, which reads the same deployment state with curl.
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
const VERCEL_VALUE = /^(?:-S|--scope|-T|--team|-t|--token|--cwd|-A|--local-config|-Q|--global-config|--api)$/;
/** The owner's Mac as ssh names it, with or without a user (deploy/linux/ssh-mac.conf). */
const MAC_HOST = /^(?:[^@\s]+@)?(?:mac|100\.66\.173\.18|main-dev-sieuns-macbook-pro-m2max(?:\.tail0c093d\.ts\.net)?)$/;
const SSH_VALUE = /^-[BbcDEeFIiJLlmOoPpQRSWw]$/;
const LIGHT_DEPLOYMENT = fileURLToPath(new URL("./vercel-deployment.sh", import.meta.url));
export const VERCEL_INSPECT_COST =
	"On 11-06 at 18:30:10Z one `vercel inspect` on the owner's Mac reached 4.41 GB within 20 s while the Mac swapped out 6,868.7 pages/s; " +
	"the same command peaked at 108 to 160 MB on us-metal02 under Vercel CLI 41 to 65 and Node 25 and 26, so the Mac-side cause is still open.";

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

/**
 * A check script such as auto-sns-agent's packages/config/kit-check.mjs: a node script named for a check that runs svelte-check, tsc or tsgo.
 * Since auto-sns-agent 380be3218 that kit-check.mjs runs only the scoped save check of the changed files in apps/search on the Mac
 * (scopedOnMac), at 1.19 GB and 7 s there on 11-08, unless KIT_CHECK_WHOLE is set, so that run gets no note. Its SCOPED table later
 * named apps/virev-demo too, whose scoped check peaked at 1.0 to 1.7 GB on us-metal02 against 4.0 GB for the whole one, so each app
 * the script names in quotes beside scopedOnMac gets no note.
 */
function checkScript(args: string[], cwd: string, vars: Map<string, string>): string | null {
	const file = args.find((a) => !a.startsWith("-"));
	if (!file || !/check/i.test(basename(file)) || /\.test\.[cm]?[jt]s$/.test(file) || args.includes("--test")) return null;
	const text = readFile(at(cwd, file));
	if (!text || !/svelte-check|\btsgo\b|\btsc\b/.test(text)) return null;
	const root = checkoutOf(cwd);
	const whole = vars.has("KIT_CHECK_WHOLE") || process.env.KIT_CHECK_WHOLE;
	const app = root ? relative(root, resolve(cwd)) : "";
	if (/\bscopedOnMac\b/.test(text) && app && text.includes(`'${app}'`) && !whole) return null;
	return `${basename(file)} runs a whole-app type check`;
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
	kind: "check" | "vercel";
	ssh?: string;
}

/** The command `ssh <args>` runs on the owner's Mac and the host as typed, or null when it goes to another host or opens a login shell. */
function sentToMac(args: string[]): { host: string; command: string } | null {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) i += SSH_VALUE.test(args[i]) ? 2 : 1;
	const host = args[i] ?? "";
	if (!MAC_HOST.test(host)) return null;
	const rest = args.slice(i + 1);
	const end = rest.findIndex((w) => /^\d+$/.test(w) || w === "}" || /^[A-Za-z_]\w*=/.test(w));
	const command = (end === -1 ? rest : rest.slice(0, end)).join(" ");
	return command ? { host, command } : null;
}

/**
 * One hit per command in `text` that runs a whole-project check or suite on the Mac, judged from `start`. `top` is the command the agent typed
 * and where it ran, and `via` names the package scripts it went through. `ssh` is the Mac host when the text runs there over ssh, "" when it
 * runs where the kernel does, and null when that is not the Mac, so only an ssh to the Mac hits. Over ssh, `~` and relative paths resolve
 * against this host's home, as us-metal02 keeps auto-sns-agent at the Mac's ~/Documents/Github/auto-sns-agent.
 */
function judge(text: string, depth: number, out: Hit[], start: string, vars: Map<string, string>, ssh: string | null, top?: { command: string; cwd: string }, via = ""): void {
	if (depth > 6) return;
	let cwd = start;
	const { commands, nested } = lex(stripHeredocs(text));
	for (const argv of expandVars(commands, vars)) {
		const eff = effective(argv);
		const name = basename(eff[0] ?? "");
		const args = eff.slice(1);
		const at0 = top ?? { command: label(eff), cwd };
		const own = new Map(vars);
		for (const w of argv.slice(0, argv.length - eff.length)) {
			const set = /^([A-Za-z_]\w*)=(.*)$/s.exec(w);
			if (set) own.set(set[1], set[2]);
		}
		const hit = (why: string, kind: Hit["kind"] = "check"): void => {
			if (ssh !== null) out.push({ ...at0, why: via + why, kind, ...ssh ? { ssh } : {} });
		};
		const again = (inner: string, where = cwd, through = via): void => judge(inner, depth + 1, out, where, new Map(own), ssh, at0, through);
		if (name === "ssh") {
			const sent = sentToMac(args);
			if (sent) judge(sent.command, depth + 1, out, homedir(), new Map(), sent.host);
			continue;
		}
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
		if ((name === "vercel" || name === "vc") && positionals(args, VERCEL_VALUE)[0] === "inspect") {
			hit("it loads the whole Vercel CLI to read one deployment", "vercel");
			continue;
		}
		const why = JS_RUNNERS.has(name) ? checkScript(args, cwd, own) : wholeRun(name.replace(/\.(?:c|m)?js$/, ""), args);
		if (why) hit(why);
	}
	for (const inner of nested) judge(inner, depth + 1, out, cwd, new Map(vars), ssh, top, via);
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

/**
 * One note per command in `text` that runs a whole-project type check or test suite or `vercel inspect` on the owner's Mac: every such command
 * on the Mac, and on another host each one it sends to the Mac over ssh.
 */
export function judgeHeavyCheck(text: string, cwd: string): string[] {
	const hits: Hit[] = [];
	judge(text, 0, hits, cwd, new Map(), onMac() ? "" : null);
	const seen = new Set<string>();
	const where = (h: Hit): string => h.ssh ? `on the owner's Mac over \`ssh ${h.ssh}\`` : "here on the owner's Mac";
	return hits.filter((h) => !seen.has(h.command) && seen.add(h.command)).map((h) => h.kind === "vercel"
		? `${PREFIX} \`${h.command.slice(0, 200)}\` runs ${where(h)}, and ${h.why}. It runs now. ${VERCEL_INSPECT_COST} ` +
			`Next time read the deployment's state, URL, commit and aliases with \`sh '${LIGHT_DEPLOYMENT}' <dpl id, URL or alias> [team slug]\`, ` +
			"which curls the Vercel REST API and peaked at 16 MB on us-metal02; for build logs, run `vercel inspect --logs` on us-metal02 over ssh."
		: `${PREFIX} \`${h.command.slice(0, 200)}\` runs ${where(h)}, because ${h.why}. It runs now. ${HEAVY_COST} ` +
			`Next time run it off the Mac. ${offMac(h.command, h.cwd)}`);
}
