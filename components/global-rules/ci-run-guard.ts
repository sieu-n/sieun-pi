import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import type { Verdict } from "./guard.ts";
import { sessionOf } from "./send-log.ts";
import { SHELLS, effective, heredocs, lex, shellScript, stripHeredocs } from "./shell.ts";

/*
 * CI runs (auto-sns-agent repo/git-workflow SKILL.md step 7: "never cancel or re-run any run"). Only the release owner and Fable,
 * whose loop keeps the CI queue, cancel, rerun or delete a GitHub Actions run of sieu-n/auto-sns-agent. Runs of other repos, such as
 * sieu-n/slack-green, are outside the rule. A run whose repo the guard cannot read counts as auto-sns-agent's. Board notes did not hold the rule: check-in
 * jobs of ***launch main bro*** reran 38492712967 at 01:13Z on 10-14, and cancelled 38514703530 at 06:25Z and 38578797513 at 15:24Z.
 * A session is judged by the chat at the root of its tree, so the two keepers' own subagents pass too.
 */

export const CI_RUN_KEEPERS: Readonly<Record<string, string>> = {
	"01a10810-34b5-710f-88fe-3d369f89a8c9": "the release owner",
	"01a0cc5e-0ca4-762a-90e6-566c310bd50a": "Fable, the CI queue keeper",
};

/** True when the session file or session dir belongs to a keeper's tree. An unknown session is not a keeper. */
export function isCiRunKeeper(sessionPath: string | undefined | null): boolean {
	const chat = sessionOf(sessionPath).chat;
	return chat !== null && Object.hasOwn(CI_RUN_KEEPERS, chat);
}

/** The repo whose runs the rule covers, as owner/name in lowercase. */
export const RULE_REPO = "sieu-n/auto-sns-agent";

/** owner/name in lowercase from `owner/name`, `HOST/owner/name`, an https or ssh remote URL, or null. */
export function repoSlug(spec: string | undefined | null): string | null {
	if (!spec) return null;
	const parts = spec.trim().replace(/^[a-z+]+:\/\/[^/]*\//i, "").replace(/^[^@/\s]+@[^:/\s]+:/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "").split("/");
	return parts.length >= 2 && parts.every(Boolean) ? parts.slice(-2).join("/").toLowerCase() : null;
}

const origins = new Map<string, string | null>();

/** The origin repo of the checkout at `dir`, or null when it is not a git checkout. */
export function originRepo(dir: string): string | null {
	if (!origins.has(dir)) {
		let url: string | null = null;
		try {
			url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
		} catch {
			url = null;
		}
		origins.set(dir, repoSlug(url));
	}
	return origins.get(dir) ?? null;
}

/** True when the rule covers a run of `repo`: auto-sns-agent's, or a repo the guard cannot read. */
const governed = (repo: string | null) => repo === null || repo === RULE_REPO;
const where = (repo: string | null) => (repo ? ` in ${repo}` : " in a repo it does not name (add --repo <owner>/<name>)");

const GITHUB_API = /^https?:\/\/(?:api\.github\.com|[^/\s]+\/api\/v3)(\/[^?#\s'"]*)/i;
const RUN_WRITE = /^\/?repos\/([^/\s]+)\/([^/\s]+)\/(?:actions\/runs\/(\d+)\/(cancel|force-cancel|rerun|rerun-failed-jobs)|actions\/jobs\/(\d+)\/(rerun)|check-(?:runs|suites)\/(\d+)\/(rerequest))\/?$/;
const RUN_PATH = /^\/?repos\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)\/?$/;
const GH_API_VALUE_FLAGS = /^(?:-X|--method|-f|--raw-field|-F|--field|-H|--header|--input|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)$/;
const GH_RUN_VERBS: Readonly<Record<string, string>> = { cancel: "cancels", rerun: "reruns", delete: "deletes" };
const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https", "xh", "xhs", "httpie"]);

function refusal(what: string): string {
	const keepers = Object.entries(CI_RUN_KEEPERS).map(([id, who]) => `${who} (${id.slice(0, 8)})`).join(" and ");
	return (
		`global-rules CI run guard: refused, because ${what}. Only ${keepers} cancel, rerun or delete a CI run, and their own subagents; ` +
		'every other session must "never cancel or re-run any run" of sieu-n/auto-sns-agent (its repo/git-workflow SKILL.md step 7). ' +
		"Do this instead: for a new attempt, push a fresh run (a new ci/ ref or probe). For a superseded, stuck or red run, send its id and why " +
		"to Fable through your chat; Fable's loop or the run's own probe family cancels it. Reading runs (gh run view, gh run watch, gh run list) stays allowed, and so do runs of other repos."
	);
}

const verdict = (what: string, command: string): Verdict => ({ rule: "ci-run", command, reason: refusal(what) });

/** A write to the Actions runs API of auto-sns-agent: a cancel, rerun or check rerequest, or a DELETE of a run. Null for reads, other paths and other repos. */
export function ciRunHttp(method: string, url: string, via = `${method.toUpperCase()} ${url}`): Verdict | null {
	const path = url.match(GITHUB_API)?.[1] ?? (url.startsWith("http") ? undefined : url);
	return path === undefined ? null : ciRunPath(method.toUpperCase(), path, via, via, null);
}

/** The repo a `repos/<owner>/<name>/...` path names; gh api's `{owner}/{repo}` placeholders read the checkout at `cwd`. */
function pathRepo(owner: string, name: string, cwd: string | null): string | null {
	if (/^[{:]/.test(owner) || /^[{:]/.test(name)) return cwd ? originRepo(cwd) : null;
	return `${owner}/${name}`.toLowerCase();
}

function ciRunPath(verb: string, path: string, via: string, line: string, cwd: string | null): Verdict | null {
	if (verb === "GET" || verb === "HEAD") return null;
	const m = path.match(RUN_WRITE);
	if (m) {
		const repo = pathRepo(m[1], m[2], cwd);
		if (!governed(repo)) return null;
		const id = m[3] ?? m[5] ?? m[7];
		const action = m[4] ?? m[6] ?? m[8];
		const noun = m[3] ? "run" : m[5] ? "job" : "check";
		return verdict(`${via} calls ${action} on ${noun} ${id}${where(repo)} through the GitHub Actions API`, line);
	}
	const run = verb === "DELETE" ? path.match(RUN_PATH) : null;
	if (!run) return null;
	const repo = pathRepo(run[1], run[2], cwd);
	return governed(repo) ? verdict(`${via} deletes run ${run[3]}${where(repo)} through the GitHub Actions API`, line) : null;
}

function ghApi(args: string[], line: string, cwd: string): Verdict | null {
	let endpoint: string | undefined;
	let method: string | undefined;
	let fields = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const eq = a.match(/^(--[\w-]+)=(.*)$/);
		const flag = eq ? eq[1] : a;
		const value = eq ? eq[2] : GH_API_VALUE_FLAGS.test(a) ? args[i + 1] ?? "" : "";
		if (!eq && GH_API_VALUE_FLAGS.test(a)) i++;
		if (flag === "-X" || flag === "--method") method = value.toUpperCase();
		else if (/^(?:-f|--raw-field|-F|--field|--input)$/.test(flag)) fields = true;
		else if (/^-X\w+$/.test(a)) method = a.slice(2).toUpperCase();
		else if (!a.startsWith("-") && endpoint === undefined) endpoint = a;
	}
	if (!endpoint) return null;
	const verb = method ?? (fields ? "POST" : "GET");
	return ciRunPath(verb, endpoint.match(GITHUB_API)?.[1] ?? endpoint, `\`gh api ${verb} ${endpoint}\``, line, cwd);
}

function httpClient(name: string, args: string[], line: string): Verdict | null {
	const methodArg = args.findIndex((a) => a === "-X" || a === "--request" || a === "--method");
	const method = (
		methodArg !== -1
			? args[methodArg + 1]
			: args.map((a) => a.match(/^(?:-X|--request=|--method=)(\w+)$/)?.[1]).find(Boolean) ?? args.find((a) => /^(?:PUT|POST|PATCH|DELETE)$/i.test(a))
	)?.toUpperCase();
	const data = args.some((a) => /^(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|--post-data|--post-file|--body-data|--body-file|-T|--upload-file)(?:=|$)/.test(a));
	const verb = method ?? (data ? "POST" : "GET");
	for (const url of args.flatMap((a) => a.match(/https?:\/\/[^\s'"`<>\\]+/gi) ?? [])) {
		const path = url.match(GITHUB_API)?.[1];
		const v = path ? ciRunPath(verb, path, `this ${name} call`, line, null) : null;
		if (v) return v;
	}
	return null;
}

/** The repo a gh command acts on: its -R/--repo flag, a GH_REPO prefix, else the origin of the checkout it runs in. */
function ghRepo(args: string[], ghRepoEnv: string | undefined, cwd: string): string | null {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-R" || args[i] === "--repo") return repoSlug(args[i + 1]);
		const eq = args[i].match(/^(?:--repo=|-R)(.+)$/);
		if (eq) return repoSlug(eq[1]);
	}
	return ghRepoEnv ? repoSlug(ghRepoEnv) : originRepo(cwd);
}

function gh(args: string[], line: string, ghRepoEnv: string | undefined, cwd: string): Verdict | null {
	if (args.some((a) => a === "-h" || a === "--help")) return null;
	const words = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && /^(?:-R|--repo|--hostname)$/.test(args[i - 1])));
	if (words[0] === "run" && Object.hasOwn(GH_RUN_VERBS, words[1] ?? "")) {
		const repo = ghRepo(args, ghRepoEnv, cwd);
		if (!governed(repo)) return null;
		const id = words[2] ? `run ${words[2]}` : "a run it picks";
		return verdict(`\`gh run ${words[1]}\` ${GH_RUN_VERBS[words[1]]} ${id}${where(repo)}`, line);
	}
	if (words[0] === "api") return ghApi(args.slice(args.indexOf("api") + 1), line, cwd);
	if (words[0] === "alias" && words[1] === "set" && /\brun\s+(?:cancel|rerun|delete)\b|actions\/(?:runs|jobs)\//.test(args.join(" "))) {
		return verdict("this gh alias hides a run cancel, rerun or delete behind a new name", line);
	}
	return null;
}

function collect(command: string, cwd: string, depth: number, out: Verdict[]): void {
	if (depth > 4) return;
	const { commands, nested } = lex(stripHeredocs(command));
	let running = cwd;
	for (const argv of commands) {
		const eff = effective(argv);
		if (!eff.length) continue;
		const name = basename(eff[0]);
		const args = eff.slice(1);
		const line = eff.join(" ");
		if (name === "cd" && args[0] && !args[0].startsWith("-")) {
			running = resolve(running, args[0].replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, process.env.HOME ?? "~"));
		} else if (SHELLS.has(name)) {
			const script = shellScript(eff);
			if (script) collect(script, running, depth + 1, out);
		} else if (name === "eval") collect(args.join(" "), running, depth + 1, out);
		else if (name === "timeout" || name === "gtimeout" || name === "xargs" || name === "ssh" || name === "watch") {
			const rest = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && /^-[a-zA-Z]$/.test(args[i - 1]) && name !== "xargs"));
			const inner = name === "xargs" || name === "watch" ? rest : rest.slice(1);
			if (inner.length) collect(inner.join(" "), running, depth + 1, out);
		} else if ((name === "perl" || name === "ruby") && args[0] === "-e" && args.length > 2) {
			// `perl -e 'alarm 60; exec @ARGV' gh run cancel <id>`, the time limit wrapper agents use on this Mac (VP of CI, 10-13 and 10-14).
			const rest = args.slice(2);
			while (rest.length && /^\d+$/.test(rest[0])) rest.shift();
			collect(rest.join(" "), running, depth + 1, out);
		} else if (/^(?:\{[^}]*\}|\$\{?\w+\}?)$/.test(eff[0]) && args.length) {
			// A prefix filled in at run time, such as `{T60} gh run cancel <id>` from a Python f-string or `$TO gh ...`.
			collect(args.join(" "), running, depth + 1, out);
		} else if (name === "gh") {
			const ghRepoEnv = argv.slice(0, argv.indexOf(eff[0])).find((w) => w.startsWith("GH_REPO="))?.slice(8);
			const v = gh(args, line, ghRepoEnv, running);
			if (v) out.push(v);
		} else if (HTTP_CLIENTS.has(name)) {
			const v = httpClient(name, args, line);
			if (v) out.push(v);
		}
	}
	for (const inner of nested) collect(inner, cwd, depth + 1, out);
}

/** Run cancels, reruns and deletes of auto-sns-agent in shell text run at `cwd`, including `bash -c`, `$(...)`, `eval`, wrappers and heredocs fed to a shell. */
export function judgeCiRunShell(text: string, cwd: string): Verdict[] {
	if (!/\bgh\b|actions\/(?:runs|jobs)|check-(?:runs|suites)/.test(text)) return [];
	const out: Verdict[] = [];
	collect(text, cwd, 0, out);
	for (const doc of heredocs(text)) {
		const feeds = lex(doc.opener).commands.some((argv) => {
			const eff = effective(argv);
			return (eff.some((w) => SHELLS.has(basename(w))) || basename(eff[0] ?? "") === "ssh") && !shellScript(eff);
		});
		if (feeds) collect(doc.body, cwd, 1, out);
	}
	return out;
}
