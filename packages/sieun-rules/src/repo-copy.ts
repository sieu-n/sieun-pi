import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Verdict } from "./guard.ts";
import { SHELLS, effective, lex, shellScript, stripHeredocs } from "./shell.ts";

/*
 * Owner rule c193, 2026-10-28: "Copying the repo to do the test: THIS MUST BE BANNED". The rule was text in the chat brief and enforced
 * in code only inside auto-sns-agent, so other repos' jobs kept copying. On 10-29 slack green guy's jobs ran `tsc --noEmit` and
 * `next dev` in `git worktree` copies under ~/scratch, each with its own node_modules, at 0.8 to 1.3 GB a run, in red minutes on the
 * owner's Mac, which held 79 slack-green worktrees at 17:20Z. This rule refuses `git worktree add`, a `git clone` whose source is a local
 * path, and `git archive` into a folder, in every repo on every host. A clone from a remote URL passes.
 * It also refuses an install, build, dev server, type check or test run inside a copy that already exists: a git worktree (its `.git` is a
 * file), a clone of another checkout on this host, or a clone beside the repo's main checkout (copyAt). At 12:04Z on 10-30 a slack
 * green guy job refused a new worktree reused the old worktree slack-green-trial-banner-checkout, ran `pnpm install` there, and its tree held 6.6 GB while the Mac read
 * 9,981 swap-outs a second. box-run.sh's own box checkout (~/box-run/<mac>/repo) is no copy.
 * Hard limit: the owner set this ban himself (c193).
 */
const PREFIX = "global-rules repo copy guard:";
export const COPY_TAIL =
	"Work in the existing checkout: run a test or check there scoped to the files you changed, or leave it to CI, and commit through a " +
	"private index (GIT_INDEX_FILE plus commit-tree), which needs no tree copy. On 10-29 slack green guy's per-job worktrees ran tsc and " +
	"next dev at about 1 GB each in the owner's Mac's red minutes. Owner rule c193: \"Copying the repo to do the test: THIS MUST BE BANNED\".";

const HINT = /\bgit\b[\s\S]*\b(?:worktree|clone|archive)\b/;
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const PM_VALUE = new Set(["-C", "--dir", "--filter", "-F", "--prefix", "--cwd", "-w", "--workspace"]);
const PM_RUNS = /^(?:install|i|ci|add|run|run-script|exec|dlx|x|test|build|dev|start|check|type-check|typecheck|lint)$/;
const TOOLS = new Set(["tsc", "tsgo", "vitest", "jest", "next", "vite", "svelte-check", "playwright", "pytest"]);

/** Whether `eff` installs, builds, serves, type-checks or tests. */
function copyRun(eff: string[]): boolean {
	const name = basename(eff[0] ?? "");
	const args = eff.slice(1);
	if (PACKAGE_MANAGERS.has(name)) {
		let k = 0;
		while (k < args.length && args[k].startsWith("-")) k += PM_VALUE.has(args[k]) ? 2 : 1;
		return PM_RUNS.test(args[k] ?? "install");
	}
	if (name === "npx" || name === "pnpx" || name === "bunx" || TOOLS.has(name)) return true;
	if (name === "uv") return args[0] === "sync" || args[0] === "run";
	return name === "node" && /node_modules\/\.bin\//.test(args[0] ?? "");
}
const RUN_HINT = /\b(?:pnpm|npm|yarn|bun|npx|tsc|tsgo|vitest|jest|next|vite|svelte-check|playwright|uv|pytest)\b/;

/** The git checkout that holds `dir`: its top folder and whether `.git` there is a file (a worktree), or null outside any checkout. */
function checkoutOf(dir: string): { top: string; worktree: boolean } | null {
	for (let at = dir, i = 0; i < 64; i++) {
		const git = join(at, ".git");
		if (existsSync(git)) return { top: at, worktree: statSync(git).isFile() };
		const up = dirname(at);
		if (up === at) return null;
		at = up;
	}
	return null;
}

/** The origin URL of the checkout at `top`, or null. */
function originUrl(top: string): string | null {
	try {
		const config = readFileSync(join(top, ".git", "config"), "utf8");
		return /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1] ?? null;
	} catch {
		return null;
	}
}

/** The folder or bundle file a local origin names, resolved from `top`, or null for a remote URL. */
function localOrigin(top: string, url: string | null): string | null {
	if (!url || !localSource(url)) return null;
	return resolve(top, url.replace(/^file:\/\//, "")).replace(/\/\.git\/?$|\/+$/, "");
}

/** One key for every spelling of the same origin: `github.com/sieu-n/slack-green` for its https, ssh and scp forms, or the local path. */
function originKey(top: string, url: string | null): string | null {
	if (!url) return null;
	const local = localOrigin(top, url);
	if (local) return local;
	const m = /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
	return m ? `${m[1].toLowerCase()}/${m[2]}` : url;
}

const roots = new Map<string, string>();
/** The root commits of the checkout at `top`, which every clone of a repo shares wherever its origin points, or "" when git cannot read them. */
function rootsOf(top: string): string {
	let found = roots.get(top);
	if (found === undefined) {
		const run = spawnSync("git", ["-C", top, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" });
		found = run.status === 0 ? run.stdout.split("\n").filter(Boolean).sort().join(" ") : "";
		roots.set(top, found);
	}
	return found;
}

/** Whether `dir` is a checkout with its own `.git` folder, so not a worktree. */
function ownCheckout(dir: string): boolean {
	try {
		return statSync(join(dir, ".git")).isDirectory();
	} catch {
		return false;
	}
}

/** When the checkout at `top` was made: its `.git` folder's birth time, or the clone-time file `.git/description` where birth times are missing. */
function born(top: string): number {
	const git = statSync(join(top, ".git"));
	if (git.birthtimeMs > 0) return git.birthtimeMs;
	try {
		return statSync(join(top, ".git", "description")).mtimeMs;
	} catch {
		return git.ctimeMs;
	}
}

const BOX_RUN = /\/box-run\/[^/]+\/repo$/;

/**
 * The main checkout of the repo that `top` holds when `top` is not it, or null. The main one is the checkout named after its origin repo,
 * then the oldest. Candidates are the folders beside `top` and beside a bundle it was cloned from; a candidate is the same repo when its
 * origin or its root commits match. A clone from a URL elsewhere passes, as `git clone <url>` itself does.
 */
function mainOf(top: string, url: string | null): string | null {
	const local = localOrigin(top, url);
	const name = url ? basename(local ?? url).replace(/\.(?:git|bundle)$/, "") : basename(top);
	const key = originKey(top, url);
	const places = new Set<string>([dirname(top), ...(local ? [dirname(local)] : [])]);
	const candidates = new Set<string>();
	for (const place of places) {
		try {
			for (const entry of readdirSync(place)) candidates.add(join(place, entry));
		} catch {}
	}
	const rank = (dir: string): [number, number] => [basename(dir) === name ? 0 : 1, born(dir)];
	const mine = rank(top);
	for (const dir of candidates) {
		if (dir === top || BOX_RUN.test(dir) || !ownCheckout(dir)) continue;
		const theirs = originUrl(dir);
		if (localOrigin(dir, theirs) === top) continue;
		const same = (key !== null && originKey(dir, theirs) === key) || (rootsOf(top) !== "" && rootsOf(dir) === rootsOf(top));
		const other = rank(dir);
		if (same && (other[0] < mine[0] || (other[0] === mine[0] && other[1] < mine[1]))) return dir;
	}
	return null;
}

/**
 * Why the checkout holding `dir` is a copy of a repo, or null when it is the repo's main checkout or no checkout. A worktree is a copy, a
 * clone of another checkout on this host is a copy, and so is a clone when another checkout of the same repo beside it is the main
 * one. The one main checkout passes wherever its origin points: a bundle, a local path or a URL.
 * On 10-30 the guard refused Prime's only checkout on us-metal02, /home/sieun/work/prime-agent-fix-p8/repo, because it was cloned from
 * all.bundle and so was not named after its origin.
 */
export function copyAt(dir: string): string | null {
	const checkout = checkoutOf(dir);
	if (!checkout) return null;
	if (BOX_RUN.test(checkout.top)) return null;
	if (checkout.worktree) return `${checkout.top} is a git worktree`;
	const url = originUrl(checkout.top);
	const local = localOrigin(checkout.top, url);
	if (local && local !== checkout.top && existsSync(join(local, ".git"))) return `${checkout.top} is a clone of the checkout ${local}`;
	const main = mainOf(checkout.top, url);
	return main ? `${checkout.top} is a copy of ${main}, the main checkout of that repo` : null;
}

const home = () => process.env.HOME || homedir();
const at = (cwd: string, path: string) => resolve(cwd, path.replace(/^~(?=\/|$)/, home()));
const SSH_VALUE = new Set("bcDEeFIiJLlmOoPpQRSWwB".split("").map((c) => `-${c}`));
/** git's global options that take a value as the next word. */
const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
/** git clone's options that take a value as the next word. */
const CLONE_VALUE = new Set(["-o", "--origin", "-b", "--branch", "-u", "--upload-pack", "--reference", "--reference-if-able", "--separate-git-dir",
	"--depth", "--shallow-since", "--shallow-exclude", "-c", "--config", "-j", "--jobs", "--template", "--filter", "--server-option", "--bundle-uri"]);

/** A clone source that names a folder on this host: a path or a file:// URL, not host:path, scheme://host or user@host:path. */
const localSource = (source: string): boolean =>
	source.startsWith("file://") || (!/^[\w+.-]+:\/\//.test(source) && !/^[^/]*:/.test(source));

function judge(text: string, depth: number, out: Verdict[], start?: string): void {
	if (depth > 6) return;
	const { commands, nested } = lex(stripHeredocs(text));
	let cwd = start;
	const push = (eff: string[], what: string): void => {
		out.push({ rule: "repo-copy", command: eff.join(" "), reason: `${PREFIX} \`${eff.join(" ").slice(0, 300)}\` ${what}. ${COPY_TAIL}` });
	};
	for (let c = 0; c < commands.length; c++) {
		const eff = effective(commands[c]);
		const name = basename(eff[0] ?? "");
		const args = eff.slice(1);
		if (name === "cd" && cwd !== undefined) { cwd = at(cwd, args[0] ?? home()); continue; }
		if (cwd !== undefined && name !== "git") {
			const flag = args.findIndex((w) => w === "-C" || w === "--dir" || w === "--prefix" || w === "--cwd");
			const dir = PACKAGE_MANAGERS.has(name) && flag !== -1 && args[flag + 1] ? at(cwd, args[flag + 1]) : cwd;
			const copy = copyRun(eff) ? copyAt(dir) : null;
			if (copy) push(eff, `runs in a copy of the repo: ${copy}`);
		}
		if (name === "git") {
			let i = 0;
			while (i < args.length && args[i].startsWith("-")) i += GIT_VALUE.has(args[i]) ? 2 : 1;
			const sub = args[i];
			const rest = args.slice(i + 1);
			if (sub === "worktree" && rest[0] === "add") push(eff, "makes a second working tree of the repo");
			else if (sub === "clone") {
				const words: string[] = [];
				for (let k = 0; k < rest.length; k++) {
					if (rest[k] === "--") { words.push(...rest.slice(k + 1)); break; }
					if (rest[k].startsWith("-")) { if (CLONE_VALUE.has(rest[k])) k++; continue; }
					words.push(rest[k]);
				}
				if (words[0] && localSource(words[0])) push(eff, "clones a checkout on this host");
			} else if (sub === "archive" && (rest.some((a) => a === "-o" || a.startsWith("--output")) || /^(?:tar|bsdtar|gtar)$/.test(basename(effective(commands[c + 1] ?? [])[0] ?? ""))))
				push(eff, "exports the tree into a copy");
			continue;
		}
		if (name === "timeout") {
			const rest = args.filter((a) => !a.startsWith("-"));
			if (rest.length > 1) judge(rest.slice(1).join(" "), depth + 1, out, cwd);
			continue;
		}
		if (name === "ssh") {
			let i = 0;
			while (i < args.length && args[i].startsWith("-")) i += SSH_VALUE.has(args[i]) ? 2 : 1;
			const remote = args.slice(i + 1).join(" ");
			if (remote) judge(remote, depth + 1, out);
			continue;
		}
		if (SHELLS.has(name)) {
			const script = shellScript(eff);
			if (script) judge(script, depth + 1, out, cwd);
		}
	}
	for (const inner of nested) judge(inner, depth + 1, out, cwd);
}

/**
 * One verdict per command in `text` that copies a repo (`git worktree add`, a clone of a local checkout, `git archive` into a folder) or,
 * when `cwd` is given, that installs, builds, serves, type-checks or tests inside an existing copy. An ssh command's remote text is judged
 * for copies only, since its folders are on the other host.
 */
export function judgeRepoCopy(text: string, cwd?: string): Verdict[] {
	const runs = cwd !== undefined && RUN_HINT.test(text);
	if (!HINT.test(text) && !runs) return [];
	const out: Verdict[] = [];
	judge(text, 0, out, runs && isAbsolute(cwd!) ? cwd : undefined);
	return out;
}
