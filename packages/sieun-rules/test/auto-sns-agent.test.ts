import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const checkout = mkdtempSync(join(tmpdir(), "auto-sns-agent-guard-"));
const guards = join(checkout, "scripts/repo/agent/guards");
after(() => rmSync(checkout, { recursive: true, force: true }));

const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { stdio: ["ignore", "pipe", "pipe"] });
function commit(files: Record<string, string>): void {
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(resolve(checkout, name, ".."), { recursive: true });
		writeFileSync(join(checkout, name), text);
	}
	git("add", "-A");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
}
const guard = (version: string) => ({
	"scripts/repo/agent/guards/prime.mjs": `import { verdict } from './index.mjs';
import { LOG_FILE } from './log.mjs';
export function onToolCall() { return verdict(); }
export function registerRepoGuard(pi, { logFile = LOG_FILE } = {}) { pi.on('tool_call', () => verdict(logFile)); }
`,
	"scripts/repo/agent/guards/index.mjs": `export function verdict() { return { block: true, reason: '${version}' }; }\n`,
	"scripts/repo/agent/guards/log.mjs": "export const LOG_FILE = '/dev/null';\n",
});

test("a guard version that cannot load keeps the last good one for later commits, and a fixed version loads", async () => {
	git("init", "-q");
	commit(guard("v1"));
	process.env.GLOBAL_RULES_AUTO_SNS_AGENT = checkout;
	const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
	const rules = (await jiti.import(resolve(import.meta.dirname, "../src/auto-sns-agent.ts"))) as typeof import("../src/auto-sns-agent.ts");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	await rules.register({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler) } as never);
	const call = () => handlers.get("tool_call")!({ toolName: "bash", input: { command: "true" } }, { cwd: checkout });
	assert.deepEqual(await call(), { block: true, reason: "v1" });

	commit({
		"scripts/repo/agent/guards/index.mjs": "import { names } from './dev.mjs';\nexport function verdict() { return { block: true, reason: 'v2' + names.size }; }\n",
		"scripts/repo/agent/guards/dev.mjs": "import { createRequire } from 'node:module';\nexport const names = new Set(createRequire(import.meta.url)('../../../dev/missing.cjs'));\n",
	});
	assert.deepEqual(await call(), { block: true, reason: "v1" });
	commit({ "README.md": "another commit, same guard tree\n" });
	assert.deepEqual(await call(), { block: true, reason: "v1" });
	assert.deepEqual(await rules.judgeKernelShell("true", checkout, undefined), { block: true, reason: "v1" });

	rmSync(join(guards, "dev.mjs"));
	commit(guard("v3"));
	assert.deepEqual(await call(), { block: true, reason: "v3" });
});
