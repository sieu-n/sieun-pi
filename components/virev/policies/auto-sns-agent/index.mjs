import { basename, resolve } from "node:path";
import * as gitGuard from "./agent-git-guard.mjs";
import { judge, stripHeredocs } from "./agent-guards.mjs";
import { log } from "../../ext-impl/virev/log.mjs";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);

/** Collect every git invocation the repo guard objects to, with its argv. */
function collectGitVerdicts(command, project, depth, out) {
	if (depth > 4) return;
	const { commands, nested } = gitGuard.lex(command);
	let running = project.cwd;
	for (const argv of commands) {
		const eff = gitGuard.effective(argv);
		if (!eff.length) continue;
		const name = basename(eff[0]);
		if (name === "cd" && eff[1] && !eff[1].startsWith("-")) {
			running = resolve(running, eff[1]);
			continue;
		}
		if (name === "git" || eff[0].endsWith("/git")) {
			const reason = gitGuard.judgeGit(eff, { ...project, cwd: running });
			if (reason) out.push({ eff, reason, cwd: running });
			continue;
		}
		if (SHELLS.has(name)) {
			const ci = eff.findIndex((w, idx) => idx > 0 && /^-[a-z]*c$/.test(w));
			if (ci !== -1 && eff[ci + 1]) collectGitVerdicts(eff[ci + 1], { ...project, cwd: running }, depth + 1, out);
		}
	}
	for (const inner of nested) collectGitVerdicts(inner, project, depth + 1, out);
}

/** `git checkout -b <new>` / `git switch -c <new>` only. `-B` resets an existing branch. */
function isNewBranchOnly(eff, cwd) {
	const { sub, args } = gitGuard.parseGit(eff, cwd);
	if (args.some((arg) => /^-[^-]*f/.test(arg) || arg === "--force" || arg === "--discard-changes")) return false;
	if (sub === "checkout") return args.includes("-b") && !args.includes("-B");
	if (sub === "switch") return args.includes("-c") && !args.includes("-C");
	return false;
}

const BLOCK_PREFIX = "virev git guard (bundled auto-sns-agent policy):";
const BLOCK_TAIL =
	"Several agents share this checkout on `sieun/dev`; this form can destroy or absorb another agent's " +
	'in-flight work. Commit with `node scripts/repo/agent/commit.mjs -m "..." <your files>`; land + staging ' +
	"deploy is `./scripts/repo/land.sh`, production is `./scripts/repo/promote.sh`. Rules: " +
	".agents/skills/repo/git-workflow/SKILL.md. Turn this guard off with `VIREV_GIT_GUARD=off`.";

export function judgeShellText(text, project) {
	const clean = stripHeredocs(text);
	const verdicts = [];

	const gitHits = [];
	collectGitVerdicts(clean, project, 0, gitHits);
	for (const hit of gitHits) {
		const printable = hit.eff.join(" ");
		if (isNewBranchOnly(hit.eff, hit.cwd)) {
			verdicts.push({
				level: "warn",
				command: printable,
				reason: `${hit.reason} allowed as a warning by the Prime Agent policy; the shared checkout stays on sieun/dev.`,
			});
			continue;
		}
		verdicts.push({ level: "block", command: printable, reason: `${BLOCK_PREFIX} ${hit.reason}. ${BLOCK_TAIL}` });
	}

	try {
		const other = judge(clean, project);
		if (other?.deny) verdicts.push({ level: "block", command: clean.trim().slice(0, 200), reason: other.deny });
		else if (other?.warn) verdicts.push({ level: "warn", command: clean.trim().slice(0, 200), reason: other.warn });
	} catch (err) {
		log("git-guard", `agent-guards judge() threw, ignored: ${err?.message}`);
	}

	if (!gitHits.length) {
		try {
			const fallback = gitGuard.analyze(clean, project);
			if (fallback) {
				verdicts.push({
					level: "block",
					command: clean.trim().slice(0, 200),
					reason: `${BLOCK_PREFIX} ${fallback}. ${BLOCK_TAIL}`,
				});
			}
		} catch (err) {
			log("git-guard", `analyze() threw, ignored: ${err?.message}`);
		}
	}
	return verdicts;
}

