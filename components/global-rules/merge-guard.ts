import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { PY_STRING, SHELLS, effective, heredocs, lex, shellScript, stripHeredocs } from "./shell.ts";
import type { Subject, Verdict } from "./guard.ts";
import { parseGit } from "./sieun-pi.ts";
import { releaseGo } from "../user-history/src/shared/release-go.ts";

/*
 * Merges and default-branch pushes (owner correction c49, 2026-10-12): a pull request merges, and a commit lands on main or master,
 * only after the owner says go on a For you todo that names that PR, or that repo and push. There is no standing "merge once checks pass" go.
 * This guard reads tool-call text, like the send guard (c37), and shares its OWNER_OK check. The release train's land.yml and promote.yml
 * dispatches and auto-sns-agent's `git push origin sieun/dev` stay outside it (VP decision, 2026-10-12). Staging lands never need the owner's
 * ok (c50), so a push, ref update or branch merge into staging passes; a PR merge whose base the command does not name stays refused.
 * While the owner's standing go is on (`releaseGo` in components/user-history/src/shared/release-go.ts, c74 of 2026-10-15: "Until the proper
 * launch, the owner pre-approves every prod promote, merge or push to main"), this guard passes every merge and push; setting it to null brings
 * the refusals back. The send guard (c37) and the CI run guard do not read it.
 */

const MUTATION = /\b(enablePullRequestAutoMerge|mergePullRequest|enqueuePullRequest|mergeBranch)\b/;
const REF_MUTATION = /\b(updateRefs?|createCommitOnBranch|deleteRef)\b/;
const DEFAULT_BRANCH = /^(?:main|master)$/;
const GITHUB_API = /^https?:\/\/(?:api\.github\.com|[^/\s]+\/api\/v3)(\/[^?#\s'"]*)/i;
const GITHUB_GRAPHQL = /^https?:\/\/(?:api\.github\.com\/graphql|[^/\s]+\/api\/graphql)\b/i;
const PULL_MERGE = /^\/?repos\/[^/\s]+\/[^/\s]+\/pulls\/(\d+)\/merge\/?$/;
const BRANCH_MERGE = /^\/?repos\/[^/\s]+\/[^/\s]+\/merges\/?$/;
const REF_UPDATE = /^\/?repos\/[^/\s]+\/([^/\s]+)\/git\/refs(?:\/heads\/(.+?))?\/?$/;
const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https", "xh", "xhs", "httpie"]);
const GH_PR_MERGE_VALUE_FLAGS = /^(?:-R|--repo|-b|--body|-F|--body-file|-t|--subject|-A|--author-email|--match-head-commit)$/;
const GH_API_VALUE_FLAGS = /^(?:-X|--method|-f|--raw-field|-F|--field|-H|--header|--input|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)$/;
const PUSH_VALUE_FLAGS = /^(?:-o|--push-option|--receive-pack|--exec|--repo)$/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A PR a todo must name: `#123`, `PR 123`, `pull request 123` or a `/pull/123` link for a number, else the id as written. */
export function prSubject(pr: string): Subject {
	if (/^\d+$/.test(pr)) return { label: `PR #${pr}`, pattern: new RegExp(String.raw`(?:#|\bPRs?\s*#?\s*|\bpull(?:\s+request)?\s*#?\s*|/pulls?/)${pr}(?!\d)`, "i") };
	return { label: pr, pattern: new RegExp(escape(pr)) };
}

/** A default-branch push a todo must name: the repo by name, and the branch or the word push ("Push sieun-pi to the public repo?"). */
export function pushSubject(repo: string, branch: string): Subject {
	const word = (w: string) => String.raw`(?<![\w/-])${escape(w)}(?![\w-])`;
	return { label: `the ${branch} push to ${repo}`, pattern: new RegExp(`^(?=[\\s\\S]*${word(repo)})(?=[\\s\\S]*(?:\\bpush|${word(branch)}))`, "i") };
}

function refusal(what: string, subject: Subject | undefined, kind: "merge" | "push"): string {
	const ask = kind === "merge" ? '"Merge it" / "Not yet"' : '"Push it" / "Not yet"';
	const example = kind === "merge" ? "gh pr merge ..." : "git push ...";
	return (
		`global-rules merge guard: refused, because ${what}. Nothing merges or lands on main or master without the owner's go on that ` +
		'PR or push (correction c49), and a standing "merge once checks pass" go does not count. ' +
		(subject
			? `Add a For you todo on your chat's board that names ${subject.label}, with choices such as ${ask}. After the owner says go, run the same ` +
				`command again with OWNER_OK=<chat id>/<todo id> in it: an env prefix in bash (\`OWNER_OK=<chat>/<todo> ${example}\`), or a ` +
				"`# OWNER_OK=<chat>/<todo>` line in an ipython cell."
			: kind === "merge"
				? "This command does not name the PR by number, so no todo can approve it. Name the PR number (gh pr merge <number>) and ask the owner on a For you todo."
				: "This command does not name the repo and branch it moves, so no todo can approve it. Name them and ask the owner on a For you todo.")
	);
}

const verdict = (what: string, command: string, subject?: Subject, kind: "merge" | "push" = "merge"): Verdict =>
	({ rule: "merge", command, reason: refusal(what, subject, kind), ...(subject ? { subject } : {}) });

function git(dir: string, ...args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || null;
	} catch {
		return null;
	}
}

const repoName = (url: string) => basename(url.replace(/\/+$/, "")).replace(/\.git$/, "");

/** A `git push` that moves main or master on its remote, with `--all`, `--mirror`, a refspec, or the current branch's push target. */
function gitPush(dir: string, args: string[], line: string): Verdict | null {
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (PUSH_VALUE_FLAGS.test(args[i])) { i++; continue; }
		if (!args[i].startsWith("-")) positional.push(args[i]);
	}
	if (args.some((a) => a === "-h" || a === "--help" || a === "-n" || a === "--dry-run")) return null;
	const remote = args.find((a) => a.startsWith("--repo="))?.slice(7) ?? positional.shift();
	const repo = remote && /[/:]/.test(remote) ? repoName(remote) : repoName(git(dir, "remote", "get-url", remote ?? "origin") ?? git(dir, "rev-parse", "--show-toplevel") ?? remote ?? "?");
	if (args.some((a) => a === "--all" || a === "--mirror" || a === "--branches")) {
		const flag = args.find((a) => a === "--all" || a === "--mirror" || a === "--branches")!;
		return verdict(`\`git push ${flag}\` moves every branch on ${repo}, main included`, line, pushSubject(repo, "main"), "push");
	}
	const current = () => (git(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}")?.replace(/^[^/]+\//, "") ?? git(dir, "symbolic-ref", "--short", "HEAD"));
	let targets: (string | null)[];
	if (positional.length) {
		targets = positional.map((spec) => {
			const bare = spec.replace(/^\+/, "");
			const dst = bare.includes(":") ? bare.slice(bare.indexOf(":") + 1) : bare;
			return dst === "HEAD" || dst === "@" ? current() : dst.replace(/^refs\/heads\//, "");
		});
	} else if (args.includes("--tags")) targets = [];
	else targets = [current()];
	const branch = targets.find((t) => t && DEFAULT_BRANCH.test(t));
	return branch ? verdict(`\`git push\` moves ${branch} on ${repo}`, line, pushSubject(repo, branch), "push") : null;
}

/** A small text file a command reads its body from (`-d @body.json`, `--input q.json`, `-F query=@q.graphql`), or "". */
function bodyFile(spec: string, cwd: string): string {
	const path = spec.replace(/^@/, "");
	if (!path || path === "-") return "";
	try {
		const full = resolve(cwd, path.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
		return existsSync(full) && statSync(full).size < 200000 ? readFileSync(full, "utf8") : "";
	} catch {
		return "";
	}
}

/** The PR a GraphQL merge mutation acts on: its pullRequestId literal, or the value given for the variable it uses. */
function graphqlPr(text: string): string | undefined {
	const literal = text.match(/pullRequestId\s*:\s*\\?["']([\w=-]+)/);
	if (literal) return literal[1];
	const variable = text.match(/pullRequestId\s*:\s*\$(\w+)/)?.[1];
	if (!variable) return undefined;
	return text.match(new RegExp(String.raw`(?:^|[\s'"])(?:-[fF]|--(?:raw-)?field)[\s=]+${variable}=([\w=-]+)|\\?["']${variable}\\?["']\s*:\s*\\?["']([\w=-]+)`))?.slice(1).find(Boolean);
}

function ghPrMerge(args: string[], line: string): Verdict | null {
	if (args.some((a) => a === "--disable-auto" || a === "-h" || a === "--help")) return null;
	let target: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (GH_PR_MERGE_VALUE_FLAGS.test(args[i])) { i++; continue; }
		if (!args[i].startsWith("-")) { target = args[i]; break; }
	}
	const pr = target?.match(/^#?(\d+)$/)?.[1] ?? target?.match(/\/pull\/(\d+)/)?.[1];
	const auto = args.includes("--auto") ? " with auto-merge" : "";
	return verdict(`\`gh pr merge\` merges ${pr ? `PR #${pr}` : target ? `"${target}"` : "the current branch's PR"}${auto}`, line, pr ? prSubject(pr) : undefined);
}

/** A REST write through gh api, curl or Python: a PR merge, a branch merge, or a ref update that moves a default branch. */
function restWrite(path: string, body: string, via: string, line: string): Verdict | null {
	const pull = path.match(PULL_MERGE);
	if (pull) return verdict(`${via} merges PR #${pull[1]} through the GitHub REST API`, line, prSubject(pull[1]));
	if (BRANCH_MERGE.test(path)) {
		const base = body.match(/\bbase\W+([\w./-]+)/)?.[1];
		return base && !DEFAULT_BRANCH.test(base) ? null : verdict(`${via} merges a branch into ${base ?? "a base it does not name"} through the GitHub REST API without a PR`, line);
	}
	const ref = path.match(REF_UPDATE);
	const branch = ref && (ref[2] ?? body.match(/\bref\W+refs\/heads\/([\w./-]+)/)?.[1]);
	if (ref && branch && DEFAULT_BRANCH.test(branch)) return verdict(`${via} moves ${branch} on ${ref[1]} through the GitHub refs API`, line, pushSubject(ref[1], branch), "push");
	return null;
}

/** A GraphQL merge mutation (a mergeBranch into staging or another non-default base passes), or a ref mutation that moves main or master or a branch it cannot read. */
function graphqlWrite(text: string, via: string, line: string): Verdict | null {
	const m = text.match(MUTATION);
	const base = m?.[1] === "mergeBranch" ? text.match(/\bbase\W+([\w./-]+)/)?.[1] : undefined;
	if (m && !(base && !DEFAULT_BRANCH.test(base))) {
		const pr = graphqlPr(text);
		return verdict(`${via} runs the GitHub ${m[1]} mutation`, line, pr ? prSubject(pr) : undefined);
	}
	const r = text.match(REF_MUTATION);
	if (!r) return null;
	const branch = text.match(/branchName\W+([\w./-]+)/)?.[1] ?? text.match(/refs\/heads\/([\w./-]+)/)?.[1];
	if (branch && !DEFAULT_BRANCH.test(branch)) return null;
	const repo = text.match(/repositoryNameWithOwner\W+[\w.-]+\/([\w.-]+)/)?.[1];
	return verdict(`${via} runs the GitHub ${r[1]} mutation on ${branch ?? "a branch it does not name"}`, line, repo && branch ? pushSubject(repo, branch) : undefined, "push");
}

function ghApi(args: string[], line: string, raw: string, cwd: string): Verdict | null {
	let endpoint: string | undefined;
	let method: string | undefined;
	let fields = false;
	let body = "";
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const eq = a.match(/^(--[\w-]+)=(.*)$/);
		const flag = eq ? eq[1] : a;
		const value = eq ? eq[2] : GH_API_VALUE_FLAGS.test(a) ? args[i + 1] ?? "" : "";
		if (!eq && GH_API_VALUE_FLAGS.test(a)) i++;
		if (flag === "-X" || flag === "--method") method = value.toUpperCase();
		else if (/^(?:-f|--raw-field|-F|--field)$/.test(flag)) {
			fields = true;
			body += ` ${value}`;
			const at = value.match(/^[\w.[\]]+=(@.+)$/)?.[1];
			if (at) body += ` ${bodyFile(at, cwd)}`;
		} else if (flag === "--input") {
			fields = true;
			body += ` ${bodyFile(value, cwd)}`;
		} else if (!a.startsWith("-") && endpoint === undefined) endpoint = a;
		else if (/^-X\w+$/.test(a)) method = a.slice(2).toUpperCase();
	}
	if (!endpoint) return null;
	const verb = method ?? (fields ? "POST" : "GET");
	if (endpoint === "graphql") return graphqlWrite(`${body} ${raw}`, "this GraphQL call", line);
	if (verb === "GET" || verb === "HEAD") return null;
	return restWrite(endpoint, body, `\`gh api ${verb} ${endpoint}\``, line);
}

function httpMerge(name: string, args: string[], line: string, raw: string, cwd: string): Verdict | null {
	const urls = args.flatMap((a) => a.match(/https?:\/\/[^\s'"`<>\\]+/gi) ?? []);
	const methodArg = args.findIndex((a) => a === "-X" || a === "--request");
	const method = (methodArg !== -1 ? args[methodArg + 1] : args.map((a) => a.match(/^(?:-X|--request=|--method=)(\w+)$/)?.[1]).find(Boolean) ?? args.find((a) => /^(?:PUT|POST|PATCH|DELETE)$/i.test(a)))?.toUpperCase();
	const dataArgs = args.filter((a, i) => i > 0 && /^(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|--post-file|--body-file|-T|--upload-file)$/.test(args[i - 1]));
	const inline = args.map((a) => a.match(/^(?:--data(?:-raw|-binary)?|--json|--post-data|--body-data|--post-file|--body-file)=(.*)$/)?.[1]).filter((v): v is string => v !== undefined);
	const data = [...dataArgs, ...inline];
	const writes = Boolean(method && method !== "GET" && method !== "HEAD") || data.length > 0;
	const body = `${data.join(" ")} ${data.map((d) => bodyFile(d.startsWith("@") || name === "wget" ? d : "", cwd)).join(" ")} ${raw}`;
	for (const url of urls) {
		const path = url.match(GITHUB_API)?.[1];
		const v = GITHUB_GRAPHQL.test(url) ? graphqlWrite(body, `this ${name} call`, line) : path && writes ? restWrite(path, body, `this ${name} call`, line) : null;
		if (v) return v;
	}
	return null;
}

function collect(command: string, raw: string, cwd: string, depth: number, out: Verdict[]): void {
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
			continue;
		}
		if (SHELLS.has(name)) {
			const script = shellScript(eff);
			if (script) collect(script, raw, running, depth + 1, out);
			continue;
		}
		if (name === "eval") {
			collect(args.join(" "), raw, running, depth + 1, out);
			continue;
		}
		if (name === "timeout" || name === "xargs" || name === "ssh" || name === "watch") {
			const rest = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && /^-[a-zA-Z]$/.test(args[i - 1]) && name !== "xargs"));
			const inner = name === "xargs" ? rest : rest.slice(1);
			if (inner.length) collect(inner.join(" "), raw, running, depth + 1, out);
			continue;
		}
		if (name === "git") {
			const call = parseGit(eff, running);
			const v = call.sub === "push" ? gitPush(call.targetDir, call.args, line) : null;
			if (v) out.push(v);
			continue;
		}
		if (name === "gh") {
			const words = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && /^(?:-R|--repo|--hostname)$/.test(args[i - 1])));
			const at = (word: string) => args.indexOf(word);
			if (words[0] === "pr" && words[1] === "merge") {
				const v = ghPrMerge(args.slice(at("merge") + 1).concat(args.slice(0, at("pr"))), line);
				if (v) out.push(v);
			} else if (words[0] === "api") {
				const v = ghApi(args.slice(at("api") + 1), line, raw, running);
				if (v) out.push(v);
			} else if (words[0] === "alias" && words[1] === "set" && /\bpr\s+merge\b|\bmerge\b.*\bapi\b|\bapi\b.*\/merge\b|\bgraphql\b/.test(args.join(" "))) {
				out.push(verdict("this gh alias hides a PR merge behind a new name", line));
			}
			continue;
		}
		if (HTTP_CLIENTS.has(name)) {
			const v = httpMerge(name, args, line, raw, running);
			if (v) out.push(v);
		}
	}
	for (const inner of nested) collect(inner, raw, cwd, depth + 1, out);
}

/** Merges in shell text, including `bash -c`, `$(...)`, `eval`, wrappers, and heredoc bodies fed to a shell. */
export function judgeMergeShell(text: string, cwd: string): Verdict[] {
	if (releaseGo.preapproval) return [];
	const out: Verdict[] = [];
	collect(text, text, cwd, 0, out);
	for (const doc of heredocs(text)) {
		const feeds = lex(doc.opener).commands.some((argv) => {
			const eff = effective(argv);
			const shell = eff.some((w) => SHELLS.has(basename(w))) || basename(eff[0] ?? "") === "ssh";
			return shell && !shellScript(eff);
		});
		if (feeds) collect(doc.body, text, cwd, 1, out);
	}
	return out;
}

const PY_REPO_PATH = /["'][^"'\n]*?(\/repos\/[^"'\s?#]+)["']/g;
const PY_HTTP_WRITE = /\.\s*(?:put|post|patch|delete)\s*\(/;
const PY_HTTP_CALL = /\.\s*(?:request|fetch|urlopen|Request)\s*\(|\burlopen\s*\(/;
const PY_WRITE_METHOD = /["'](?:PUT|POST|PATCH|DELETE)["']|\bdata\s*=/;
const PY_GRAPHQL = /\bgraphql\b/i;

/** Merges and default-branch ref updates written as Python in an ipython cell, sent with an HTTP write call. */
export function judgeMergePython(code: string): Verdict[] {
	if (releaseGo.preapproval) return [];
	const sites = code.replace(new RegExp(`${PY_STRING.source}|#[^\n]*`, "g"), (text) => " ".repeat(text.length));
	if (!PY_HTTP_WRITE.test(sites) && !(PY_HTTP_CALL.test(sites) && PY_WRITE_METHOD.test(code))) return [];
	for (const m of code.matchAll(PY_REPO_PATH)) {
		const v = restWrite(m[1], code, "this cell", "HTTP write to GitHub in Python");
		if (v) return [v];
	}
	const v = PY_GRAPHQL.test(code) ? graphqlWrite(code, "this cell", "GraphQL write in Python") : null;
	return v ? [v] : [];
}
