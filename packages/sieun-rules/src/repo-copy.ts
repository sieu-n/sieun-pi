import { basename } from "node:path";
import type { Verdict } from "./guard.ts";
import { SHELLS, effective, lex, shellScript, stripHeredocs } from "./shell.ts";

/*
 * Owner rule c193, 2026-10-28: "Copying the repo to do the test: THIS MUST BE BANNED". The rule was text in the chat brief and enforced
 * in code only inside auto-sns-agent, so other repos' jobs kept copying. On 10-29 slack green guy's jobs ran `tsc --noEmit` and
 * `next dev` in `git worktree` copies under ~/scratch, each with its own node_modules, at 0.8 to 1.3 GB a run, in red minutes on the
 * owner's Mac, which held 79 slack-green worktrees at 17:20Z. This rule refuses `git worktree add`, a `git clone` whose source is a local
 * path, and `git archive` into a folder, in every repo on every host. A clone from a remote URL passes.
 * Hard limit: the owner set this ban himself (c193).
 */
const PREFIX = "global-rules repo copy guard:";
export const COPY_TAIL =
	"Work in the existing checkout: run a test or check there scoped to the files you changed, or leave it to CI, and commit through a " +
	"private index (GIT_INDEX_FILE plus commit-tree), which needs no tree copy. On 10-29 slack green guy's per-job worktrees ran tsc and " +
	"next dev at about 1 GB each in the owner's Mac's red minutes. Owner rule c193: \"Copying the repo to do the test: THIS MUST BE BANNED\".";

const HINT = /\bgit\b[\s\S]*\b(?:worktree|clone|archive)\b/;
const SSH_VALUE = new Set("bcDEeFIiJLlmOoPpQRSWwB".split("").map((c) => `-${c}`));
/** git's global options that take a value as the next word. */
const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
/** git clone's options that take a value as the next word. */
const CLONE_VALUE = new Set(["-o", "--origin", "-b", "--branch", "-u", "--upload-pack", "--reference", "--reference-if-able", "--separate-git-dir",
	"--depth", "--shallow-since", "--shallow-exclude", "-c", "--config", "-j", "--jobs", "--template", "--filter", "--server-option", "--bundle-uri"]);

/** A clone source that names a folder on this host: a path or a file:// URL, not host:path, scheme://host or user@host:path. */
const localSource = (source: string): boolean =>
	source.startsWith("file://") || (!/^[\w+.-]+:\/\//.test(source) && !/^[^/]*:/.test(source));

function judge(text: string, depth: number, out: Verdict[]): void {
	if (depth > 6) return;
	const { commands, nested } = lex(stripHeredocs(text));
	const push = (eff: string[], what: string): void => {
		out.push({ rule: "repo-copy", command: eff.join(" "), reason: `${PREFIX} \`${eff.join(" ").slice(0, 300)}\` ${what}. ${COPY_TAIL}` });
	};
	for (let c = 0; c < commands.length; c++) {
		const eff = effective(commands[c]);
		const name = basename(eff[0] ?? "");
		const args = eff.slice(1);
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
			if (rest.length > 1) judge(rest.slice(1).join(" "), depth + 1, out);
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

/** One verdict per command in `text` that copies a repo: `git worktree add`, a clone of a local checkout, or `git archive` into a folder. */
export function judgeRepoCopy(text: string): Verdict[] {
	if (!HINT.test(text)) return [];
	const out: Verdict[] = [];
	judge(text, 0, out);
	return out;
}
