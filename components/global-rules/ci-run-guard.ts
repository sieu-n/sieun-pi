import { basename } from "node:path";
import type { Verdict } from "./guard.ts";
import { sessionOf } from "./send-log.ts";
import { SHELLS, effective, heredocs, lex, shellScript, stripHeredocs } from "./shell.ts";

/*
 * CI runs (auto-sns-agent repo/git-workflow SKILL.md step 7: "never cancel or re-run any run"). Only the release owner and Fable,
 * whose loop keeps the CI queue, cancel, rerun or delete a GitHub Actions run, in any repo. Board notes did not hold the rule: check-in
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

const GITHUB_API = /^https?:\/\/(?:api\.github\.com|[^/\s]+\/api\/v3)(\/[^?#\s'"]*)/i;
const RUN_WRITE = /^\/?repos\/[^/\s]+\/[^/\s]+\/(?:actions\/runs\/(\d+)\/(cancel|force-cancel|rerun|rerun-failed-jobs)|actions\/jobs\/(\d+)\/(rerun)|check-(?:runs|suites)\/(\d+)\/(rerequest))\/?$/;
const RUN_PATH = /^\/?repos\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)\/?$/;
const GH_API_VALUE_FLAGS = /^(?:-X|--method|-f|--raw-field|-F|--field|-H|--header|--input|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)$/;
const GH_RUN_VERBS: Readonly<Record<string, string>> = { cancel: "cancels", rerun: "reruns", delete: "deletes" };
const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https", "xh", "xhs", "httpie"]);

function refusal(what: string): string {
	const keepers = Object.entries(CI_RUN_KEEPERS).map(([id, who]) => `${who} (${id.slice(0, 8)})`).join(" and ");
	return (
		`global-rules CI run guard: refused, because ${what}. Only ${keepers} cancel, rerun or delete a CI run, and their own subagents; ` +
		'every other session must "never cancel or re-run any run" (auto-sns-agent repo/git-workflow SKILL.md step 7). ' +
		"Do this instead: for a new attempt, push a fresh run (a new ci/ ref or probe). For a superseded, stuck or red run, send its id and why " +
		"to Fable through your chat; Fable's loop or the run's own probe family cancels it. Reading runs (gh run view, gh run watch, gh run list) stays allowed."
	);
}

const verdict = (what: string, command: string): Verdict => ({ rule: "ci-run", command, reason: refusal(what) });

/** A write to the Actions runs API: a cancel, rerun or check rerequest, or a DELETE of a run. Null for reads and every other path. */
export function ciRunHttp(method: string, url: string, via = `${method.toUpperCase()} ${url}`): Verdict | null {
	const path = url.match(GITHUB_API)?.[1] ?? (url.startsWith("http") ? undefined : url);
	return path === undefined ? null : ciRunPath(method.toUpperCase(), path, via, via);
}

function ciRunPath(verb: string, path: string, via: string, line: string): Verdict | null {
	if (verb === "GET" || verb === "HEAD") return null;
	const m = path.match(RUN_WRITE);
	if (m) {
		const id = m[1] ?? m[3] ?? m[5];
		const action = m[2] ?? m[4] ?? m[6];
		const noun = m[1] ? "run" : m[3] ? "job" : "check";
		return verdict(`${via} calls ${action} on ${noun} ${id} through the GitHub Actions API`, line);
	}
	const run = verb === "DELETE" ? path.match(RUN_PATH) : null;
	return run ? verdict(`${via} deletes run ${run[1]} through the GitHub Actions API`, line) : null;
}

function ghApi(args: string[], line: string): Verdict | null {
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
	return ciRunPath(verb, endpoint.match(GITHUB_API)?.[1] ?? endpoint, `\`gh api ${verb} ${endpoint}\``, line);
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
		const v = path ? ciRunPath(verb, path, `this ${name} call`, line) : null;
		if (v) return v;
	}
	return null;
}

function gh(args: string[], line: string): Verdict | null {
	if (args.some((a) => a === "-h" || a === "--help")) return null;
	const words = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && /^(?:-R|--repo|--hostname)$/.test(args[i - 1])));
	if (words[0] === "run" && Object.hasOwn(GH_RUN_VERBS, words[1] ?? "")) {
		const id = words[2] ? `run ${words[2]}` : "a run it picks";
		return verdict(`\`gh run ${words[1]}\` ${GH_RUN_VERBS[words[1]]} ${id}`, line);
	}
	if (words[0] === "api") return ghApi(args.slice(args.indexOf("api") + 1), line);
	if (words[0] === "alias" && words[1] === "set" && /\brun\s+(?:cancel|rerun|delete)\b|actions\/(?:runs|jobs)\//.test(args.join(" "))) {
		return verdict("this gh alias hides a run cancel, rerun or delete behind a new name", line);
	}
	return null;
}

function collect(command: string, depth: number, out: Verdict[]): void {
	if (depth > 4) return;
	const { commands, nested } = lex(stripHeredocs(command));
	for (const argv of commands) {
		const eff = effective(argv);
		if (!eff.length) continue;
		const name = basename(eff[0]);
		const args = eff.slice(1);
		const line = eff.join(" ");
		if (SHELLS.has(name)) {
			const script = shellScript(eff);
			if (script) collect(script, depth + 1, out);
		} else if (name === "eval") collect(args.join(" "), depth + 1, out);
		else if (name === "timeout" || name === "gtimeout" || name === "xargs" || name === "ssh" || name === "watch") {
			const rest = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && /^-[a-zA-Z]$/.test(args[i - 1]) && name !== "xargs"));
			const inner = name === "xargs" || name === "watch" ? rest : rest.slice(1);
			if (inner.length) collect(inner.join(" "), depth + 1, out);
		} else if ((name === "perl" || name === "ruby") && args[0] === "-e" && args.length > 2) {
			// `perl -e 'alarm 60; exec @ARGV' gh run cancel <id>`, the time limit wrapper agents use on this Mac (VP of CI, 10-13 and 10-14).
			const rest = args.slice(2);
			while (rest.length && /^\d+$/.test(rest[0])) rest.shift();
			collect(rest.join(" "), depth + 1, out);
		} else if (/^(?:\{[^}]*\}|\$\{?\w+\}?)$/.test(eff[0]) && args.length) {
			// A prefix filled in at run time, such as `{T60} gh run cancel <id>` from a Python f-string or `$TO gh ...`.
			collect(args.join(" "), depth + 1, out);
		} else if (name === "gh") {
			const v = gh(args, line);
			if (v) out.push(v);
		} else if (HTTP_CLIENTS.has(name)) {
			const v = httpClient(name, args, line);
			if (v) out.push(v);
		}
	}
	for (const inner of nested) collect(inner, depth + 1, out);
}

/** Run cancels, reruns and deletes in shell text, including `bash -c`, `$(...)`, `eval`, wrappers and heredocs fed to a shell. */
export function judgeCiRunShell(text: string): Verdict[] {
	if (!/\bgh\b|actions\/(?:runs|jobs)|check-(?:runs|suites)/.test(text)) return [];
	const out: Verdict[] = [];
	collect(text, 0, out);
	for (const doc of heredocs(text)) {
		const feeds = lex(doc.opener).commands.some((argv) => {
			const eff = effective(argv);
			return (eff.some((w) => SHELLS.has(basename(w))) || basename(eff[0] ?? "") === "ssh") && !shellScript(eff);
		});
		if (feeds) collect(doc.body, 1, out);
	}
	return out;
}
