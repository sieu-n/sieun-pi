import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Verdict } from "./guard.ts";
import { SHELLS, effective, lex, shellScript, stripHeredocs } from "./shell.ts";

// sieun-pi has one contributor, so its local checkout is ground truth (owner, 2026-10-09).
// Rewriting commits that no remote branch holds needs no ask; history on a remote is never rewritten.
// The rule follows the target checkout, so it applies whatever the session cwd is.
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = /[/:]sieu-n\/sieun-pi(?:\.git)?\/?$/;
const REBASE_STEP = new Set(["--continue", "--abort", "--skip", "--quit", "--edit-todo", "--show-current-patch"]);
const REBASE_VALUE_OPTS = new Set(["--onto", "-s", "--strategy", "-X", "--strategy-option", "-x", "--exec"]);

const PREFIX = "global-rules sieun-pi guard:";
export const SIEUN_PI_TAIL =
	"sieun-pi has one contributor, so its local checkout is ground truth: rebase and amend are fine while " +
	"no remote branch holds the commits they rewrite. History already on a remote is never rewritten, and " +
	"`git reset --hard` would drop uncommitted work in the checkout.";

/** The shell expands `~` and `$HOME` before git sees the path; resolve() does not. */
const expandHome = (p: string) => p.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());

export const isForcePush = (a: string[]) =>
	a.some((w) => /^-[^-]*f/.test(w) || w === "--force" || w === "--force-with-lease" || w.startsWith("--force-with-lease=") || w.startsWith("+"));

export interface GitCall {
	targetDir: string;
	sub: string | undefined;
	args: string[];
}

export function parseGit(eff: string[], cwd: string): GitCall {
	let i = 1;
	let dir = cwd;
	let gitDir: string | null = null;
	while (i < eff.length) {
		const a = eff[i];
		if (a === "-C") { dir = resolve(dir, expandHome(eff[i + 1] ?? ".")); i += 2; continue; }
		if (a === "-c" || a === "--config-env") { i += 2; continue; }
		if (a === "--git-dir") { gitDir = resolve(dir, expandHome(eff[i + 1] ?? ".")); i += 2; continue; }
		if (a.startsWith("--git-dir=")) { gitDir = resolve(dir, expandHome(a.slice(10))); i++; continue; }
		if (a === "--work-tree") { dir = resolve(dir, expandHome(eff[i + 1] ?? ".")); i += 2; continue; }
		if (a.startsWith("--work-tree=")) { dir = resolve(dir, expandHome(a.slice(12))); i++; continue; }
		if (a.startsWith("-")) { i++; continue; }
		break;
	}
	return { targetDir: gitDir ? dirname(gitDir) : dir, sub: eff[i], args: eff.slice(i + 1) };
}

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
	}).trim();
}

function isSieunPi(dir: string): boolean {
	let top: string;
	try { top = realpathSync(git(dir, "rev-parse", "--show-toplevel")); } catch { return false; }
	try { if (top === realpathSync(SOURCE_ROOT)) return true; } catch { /* packaged copy without a checkout */ }
	try { return ORIGIN.test(git(dir, "remote", "get-url", "origin")); } catch { return false; }
}

/** The revisions `git rebase <args>` rewrites: `<upstream>..<branch>`, or all of `<branch>` with --root. */
function rebaseRange(args: string[]): string[] {
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (REBASE_VALUE_OPTS.has(args[i])) i++;
		else if (!args[i].startsWith("-")) positional.push(args[i]);
	}
	if (args.includes("--root")) return [positional[0] ?? "HEAD"];
	const [upstream = "@{upstream}", branch = "HEAD"] = positional;
	return [`${upstream}..${branch}`];
}

function onRemote(dir: string, range: string[]): boolean {
	const all = git(dir, "rev-list", "--count", ...range);
	return all !== git(dir, "rev-list", "--count", ...range, "--not", "--remotes");
}

/** Reason to block one git argv in a sieun-pi checkout, or null. Other repos return null. */
export function judgeGit(eff: string[], cwd: string): string | null {
	const { targetDir, sub, args } = parseGit(eff, cwd);
	const rebase = sub === "rebase" && !args.some((a) => REBASE_STEP.has(a));
	const amend = sub === "commit" && args.includes("--amend");
	const force = sub === "push" && isForcePush(args);
	const hard = sub === "reset" && args.includes("--hard");
	if (!(rebase || amend || force || hard) || !isSieunPi(targetDir)) return null;
	if (force) return "`git push --force` in sieun-pi";
	if (hard) return "`git reset --hard` in sieun-pi";
	try {
		if (amend) return git(targetDir, "branch", "-r", "--contains", "HEAD") ? "`git commit --amend`: HEAD is already on a remote branch" : null;
		return onRemote(targetDir, rebaseRange(args)) ? "`git rebase`: it rewrites commits already on a remote branch" : null;
	} catch {
		return `\`git ${sub}\`: could not prove the rewritten commits are on no remote branch`;
	}
}

function collect(command: string, cwd: string, depth: number, out: Verdict[]): void {
	if (depth > 4) return;
	const { commands, nested } = lex(command);
	let running = cwd;
	for (const argv of commands) {
		const eff = effective(argv);
		if (!eff.length) continue;
		const name = basename(eff[0]);
		if (name === "cd" && eff[1] && !eff[1].startsWith("-")) {
			running = resolve(running, expandHome(eff[1]));
			continue;
		}
		if (name === "git" || eff[0].endsWith("/git")) {
			const reason = judgeGit(eff, running);
			if (reason) out.push({ rule: "sieun-pi", command: eff.join(" "), reason: `${PREFIX} ${reason}. ${SIEUN_PI_TAIL}` });
			continue;
		}
		if (SHELLS.has(name)) {
			const script = shellScript(eff);
			if (script) collect(script, running, depth + 1, out);
		}
	}
	for (const inner of nested) collect(inner, cwd, depth + 1, out);
}

export function judgeSieunPi(text: string, cwd: string): Verdict[] {
	const out: Verdict[] = [];
	collect(stripHeredocs(text), cwd, 0, out);
	return out;
}
