import { basename } from "node:path";
import type { Verdict } from "./guard.ts";
import { SHELLS, effective, lex, shellScript, stripHeredocs } from "./shell.ts";

/*
 * A kill by pattern stops every process on the box whose name or command line matches, the owner's apps and other sessions' workers
 * included. On 10-29 at 04:24:48 KST a job on the owner's Mac ran `pkill -f 'svelte-check' -U $(id -u)`; macOS pkill read -U and 501
 * as more patterns, SIGTERMed every process with 501 in its argv and closed the Prime worker that held 43 sessions, with Slack, Chrome
 * and VS Code helpers (board step p1266). At 05:44 KST another job ran `pkill -9 -f 'autopair-real-ig.mjs --local'`, a pattern that
 * reaches any session's run. This rule refuses pkill, killall, and a kill fed by pgrep, pidof or ps, through a pipe to xargs, a
 * `$(...)`, a variable or a loop. A kill of a literal pid or process group passes, as does one whose pid came from `$!` or a pid file.
 * Hard limit: a stray kill is a destructive action on shared state (c98).
 */
const PREFIX = "global-rules kill guard:";
export const KILL_TAIL =
	"Stop only a process you started: call `h.kill()` on its bash() handle, or `kill <pid>` (or `kill -- -<pgid>` for a group you " +
	"started) with the pid you kept from `$!`, `h.pid` or a pid file; use pgrep or ps only to look. On 10-29 at 04:24 KST " +
	"`pkill -f 'svelte-check' -U $(id -u)` on the owner's Mac killed every process with 501 in its argv, a Prime worker's 43 sessions " +
	"included. This is a hard limit, because a stray kill is destructive to shared state (c98).";

const KILLERS = new Set(["kill", "pkill", "killall"]);
const SOURCES = new Set(["pgrep", "pidof", "ps"]);
const SSH_VALUE = new Set("bcDEeFIiJLlmOoPpQRSWwB".split("").map((c) => `-${c}`));
const HINT = /\b(?:pkill|killall|kill)\b/;

/** The program names of the commands in `text` and in its `$(...)` and subshell bodies. */
function programs(text: string, depth = 0): Set<string> {
	const names = new Set<string>();
	if (depth > 4) return names;
	const { commands, nested } = lex(text);
	for (const argv of commands) names.add(basename(effective(argv)[0] ?? ""));
	for (const inner of nested) for (const name of programs(inner, depth + 1)) names.add(name);
	return names;
}

/** The pids `kill` targets: the words after its signal option, with `--` dropped. */
function targets(args: string[]): string[] {
	let k = 0;
	if (args[k] === "-s" || args[k] === "-n") k += 2;
	else if (args[k] && /^-(?:[A-Za-z]+\d*|\d+)$/.test(args[k])) k += 1;
	if (args[k] === "--") k += 1;
	return args.slice(k);
}

function judge(text: string, depth: number, out: Verdict[]): void {
	if (depth > 6) return;
	const clean = stripHeredocs(text);
	const { commands, nested } = lex(clean);
	const sources = [...programs(clean)].filter((name) => SOURCES.has(name));
	const fed = new Set<string>();
	const push = (eff: string[], what: string): void => {
		out.push({ rule: "kill", command: eff.join(" "), reason: `${PREFIX} \`${eff.join(" ").slice(0, 300)}\` ${what}. ${KILL_TAIL}` });
	};
	for (const raw of commands) {
		if (raw[0] === "for" && raw[2] === "in" && raw.length === 3) fed.add(raw[1]);
		const eff = effective(raw);
		const name = basename(eff[0] ?? "");
		const args = eff.slice(1);
		for (const w of raw) if (/^[A-Za-z_]\w*=$/.test(w)) fed.add(w.slice(0, -1));
		if (name === "read") for (const a of args) if (!a.startsWith("-")) fed.add(a);
		if (name === "pkill" || name === "killall") {
			push(eff, `kills every process whose ${name === "killall" ? "name" : "name or command line"} matches, in every session on the box`);
			continue;
		}
		if (name === "kill") {
			const pids = targets(args);
			if (pids.some((p) => p === "-1")) push(eff, "signals every process you may signal (pid -1)");
			else if (sources.length && (pids.length === 0 || pids.some((p) => /^-?\$\{?(\w+)\}?$/.test(p) && fed.has(p.replace(/^-?\$\{?|\}$/g, "")))))
				push(eff, `kills the pids ${sources.join(" or ")} found by pattern`);
			continue;
		}
		if (name === "xargs") {
			const killer = args.find((a) => KILLERS.has(basename(a)));
			if (killer && (basename(killer) !== "kill" || sources.length)) push(eff, `kills the pids ${sources.join(" or ") || "a pattern"} found`);
			continue;
		}
		if (name === "timeout" || name === "watch") {
			const rest = args.filter((a) => !a.startsWith("-"));
			if (rest.length > 1) judge(rest.slice(name === "timeout" ? 1 : 0).join(" "), depth + 1, out);
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
			if (script) judge(script, depth + 1, out);
		}
	}
	for (const inner of nested) judge(inner, depth + 1, out);
}

/** One verdict per command in `text` that kills by pattern: pkill, killall, or kill fed by pgrep, pidof or ps. */
export function judgeKill(text: string): Verdict[] {
	if (!HINT.test(text)) return [];
	const out: Verdict[] = [];
	judge(text, 0, out);
	return out;
}
