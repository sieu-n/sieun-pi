import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { headModules } from "./auto-sns-agent-head-modules.mjs";

// The kernel half of auto-sns-agent's repo guard judges a git push by the repo it targets: the kernel's real cwd, cd and git -C,
// resolved through symlinks, then the push remote's URL. On us-metal02 /Users/sieunpark is a symlink to /home/sieun, and a session
// started in /Users/sieunpark/Documents/Github/auto-sns-agent pushed sieun-pi main from a kernel in ~/src/sieun-pi on 10-18 at 06:14Z.
// auto-sns-agent's ci/guard-ipython-push-main-r3 leaves such a push in an ipython cell to this half, so this half must allow sieun-pi
// main (c74) and refuse auto-sns-agent main from both the box and the Mac path. The fixture holds the live checkout's guards.
const SOURCE = join(homedir(), "Documents/Github/auto-sns-agent/scripts/repo/agent/guards");
const skip = !existsSync(SOURCE) && "no auto-sns-agent checkout on this machine";
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-kernel-push-")));
const BOX = join(root, "home/sieun");
const MAC = join(root, "Users/sieunpark");
const git = (...args) => execFileSync("/usr/bin/git", args, { env: { PATH: process.env.PATH ?? "" } });

if (!skip) {
	const checkout = join(BOX, "Documents/Github/auto-sns-agent");
	mkdirSync(join(checkout, "scripts/repo/agent"), { recursive: true });
	cpSync(SOURCE, join(checkout, "scripts/repo/agent/guards"), { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
	// The guards also load these from HEAD (agent-branch.mjs headModule), so the fixture commits them too.
	const modules = headModules(SOURCE);
	for (const rel of modules) cpSync(join(SOURCE, "../../../..", rel), join(checkout, rel));
	git("init", "-q", "-b", "sieun/dev", checkout);
	git("-C", checkout, "remote", "add", "origin", "https://github.com/sieu-n/auto-sns-agent");
	// The guard loads from the checkout's HEAD.
	git("-C", checkout, "add", "scripts/repo/agent/guards", ...modules);
	git("-C", checkout, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "guards");
	const sieunPi = join(BOX, "src/sieun-pi");
	mkdirSync(sieunPi, { recursive: true });
	git("init", "-q", "-b", "main", sieunPi);
	git("-C", sieunPi, "remote", "add", "origin", "https://github.com/sieu-n/sieun-pi.git");
	symlinkSync(sieunPi, join(BOX, "Documents/Github/sieun-pi"));
	mkdirSync(join(root, "Users"));
	symlinkSync(BOX, MAC);
}
test.after(() => rmSync(root, { recursive: true, force: true }));

// judgeKernelCheck as kernel-guard.py runs it: a fresh node with the kernel's HOME, the checkout path and no RLM_SESSION_DIR.
function judgeAll(home, checks) {
	const script = `
		const { judgeKernelCheck } = await import(${JSON.stringify(new URL("../packages/sieun-rules/src/send-check.ts", import.meta.url).href)});
		const out = [];
		for (const c of ${JSON.stringify(checks)}) out.push(await judgeKernelCheck({ kind: "shell", repo: true, ...c }));
		console.log(JSON.stringify(out));`;
	const env = { ...process.env, HOME: home, GLOBAL_RULES_AUTO_SNS_AGENT: join(home, "Documents/Github/auto-sns-agent"),
		GLOBAL_RULES_LOG: join(root, "global-rules.log"), GLOBAL_RULES_SEND_LOG: join(root, "sends.jsonl"), REPO_GUARD_LOG: join(root, "repo-guard.jsonl") };
	delete env.RLM_SESSION_DIR;
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env });
	return JSON.parse(out.trim().split("\n").at(-1));
}

const ruleOf = (verdict) => (verdict.block ? /^repo guard \(([\w-]+)\)/.exec(verdict.reason)?.[1] ?? verdict.reason : null);

for (const [name, home] of [["box", BOX], ["Mac", MAC]]) {
	for (const [kernelHome, kernelName] of [[BOX, "box"], [MAC, "Mac"]]) {
		test(`with the ${name} checkout path, a kernel at the ${kernelName} path pushes sieun-pi main and is refused auto-sns-agent main`, { skip }, () => {
			const asa = join(kernelHome, "Documents/Github/auto-sns-agent");
			const pi = join(kernelHome, "src/sieun-pi");
			const cases = [
				["git push origin HEAD:main", pi, null],
				["git push origin HEAD:main", join(kernelHome, "Documents/Github/sieun-pi"), null],
				["git -C ~/src/sieun-pi push origin HEAD:main", asa, null],
				["cd ~/Documents/Github/sieun-pi && git push origin bdb21df21:refs/heads/main", asa, null],
				["git push origin HEAD:main", asa, "git-push-main"],
				["git -C ~/Documents/Github/auto-sns-agent push origin HEAD:main", pi, "git-push-main"],
				[`cd ${asa} && git push origin HEAD:refs/heads/main`, pi, "git-push-main"],
				["git push https://github.com/sieu-n/auto-sns-agent HEAD:main", pi, "git-push-main"],
			];
			const verdicts = judgeAll(home, cases.map(([text, cwd]) => ({ text, cwd })));
			assert.deepEqual(verdicts.map(ruleOf), cases.map(([, , rule]) => rule), JSON.stringify(cases.map(([t, c]) => `${t} @ ${c}`)));
		});
	}
}
