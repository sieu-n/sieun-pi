import { basename } from "node:path";
import type { Verdict } from "./guard.ts";
import { SHELLS, effective, expandVars, lex, shellScript, stripHeredocs } from "./shell.ts";

/*
 * A pm2 command reads the God Daemon in its PM2_HOME and starts an empty one there when none runs. A relative PM2_HOME is a folder under the
 * command's cwd, so the auto-sns-agent docs' `PM2_HOME=.cache/pm2-dev pm2 ...`, run from apps/virev-demo at 07:19Z on 10-26, started a second
 * daemon in apps/virev-demo/.cache/pm2-dev that held 50 MB on the Mac with no app until 10-28, as one had on 10-18. The whole-system duty flags
 * such a daemon (idle_pm2_daemons); this rule refuses the command that would start it.
 */
const PREFIX = "global-rules pm2 guard:";
export const PM2_TAIL =
	"A relative PM2_HOME is a folder under the command's cwd, and pm2 starts an empty God Daemon in a home where none runs: on 10-26 " +
	"`PM2_HOME=.cache/pm2-dev pm2 ...` run in apps/virev-demo left one there with no app for two days. Give PM2_HOME the absolute home of the " +
	"daemon you mean, such as /Users/sieunpark/Documents/Github/auto-sns-agent/.cache/pm2-dev on the Mac or " +
	"/home/sieun/Documents/Github/auto-sns-agent/.cache/pm2-dev on us-metal02.";
const SSH_VALUE = new Set("bcDEeFIiJLlmOoPpQRSWwB".split("").map((c) => `-${c}`));

/** Whether `eff` runs the pm2 CLI: pm2 by any path, or through npx, pnpm or yarn. */
function runsPm2(eff: string[]): boolean {
	const name = basename(eff[0] ?? "");
	if (name === "pm2") return true;
	const rest = eff.slice(1).filter((w) => !w.startsWith("-"));
	if (name === "npx") return basename(rest[0] ?? "") === "pm2";
	if (name === "pnpm" || name === "yarn") return (rest[0] === "exec" || rest[0] === "dlx" ? rest[1] : rest[0]) === "pm2";
	return false;
}

/** The PM2_HOME a command sets in front of its program, its `env` words included, or undefined. */
function homeOf(argv: string[], eff: string[]): string | undefined {
	const set = argv.slice(0, argv.length - eff.length).filter((w) => w.startsWith("PM2_HOME="));
	return set.at(-1)?.slice("PM2_HOME=".length);
}

const relative = (home: string): boolean => home !== "" && !/^[/~$]/.test(home);

function judge(text: string, depth: number, out: Verdict[], vars: Map<string, string>, loops: Map<string, string[]>): void {
	if (depth > 6) return;
	const { commands, nested } = lex(stripHeredocs(text));
	for (const raw of commands) {
		if (raw[0] === "for" && raw[2] === "in") loops.set(raw[1], raw.slice(3));
		const [argv] = expandVars([raw], vars);
		if (!argv) continue;
		const eff = effective(argv);
		const name = basename(eff[0] ?? "");
		if (runsPm2(eff)) {
			const home = homeOf(argv, eff) ?? vars.get("PM2_HOME");
			const loop = home && /^\$\{?(\w+)\}?$/.exec(home);
			const homes = loop && loops.has(loop[1]) ? loops.get(loop[1])! : home === undefined ? [] : [home];
			const bad = homes.find(relative);
			if (bad !== undefined)
				out.push({ rule: "pm2", command: eff.join(" "), reason: `${PREFIX} \`${argv.join(" ").slice(0, 300)}\` runs pm2 with the relative PM2_HOME ${bad}. ${PM2_TAIL}` });
			continue;
		}
		if (name === "ssh") {
			const args = eff.slice(1);
			let i = 0;
			while (i < args.length && args[i].startsWith("-")) i += SSH_VALUE.has(args[i]) ? 2 : 1;
			const remote = args.slice(i + 1).join(" ");
			if (remote) judge(remote, depth + 1, out, new Map(), new Map());
			continue;
		}
		if (SHELLS.has(name)) {
			const script = shellScript(eff);
			if (script) judge(script, depth + 1, out, new Map(vars), new Map(loops));
		}
	}
	for (const inner of nested) judge(inner, depth + 1, out, new Map(vars), new Map(loops));
}

/** One verdict per pm2 command in `text` whose PM2_HOME is relative. */
export function judgePm2(text: string): Verdict[] {
	if (!text.includes("pm2")) return [];
	const out: Verdict[] = [];
	judge(text, 0, out, new Map(), new Map());
	return out;
}
