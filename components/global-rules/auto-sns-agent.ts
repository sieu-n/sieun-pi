import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ToolCallEvent } from "prime-agent";

/*
 * auto-sns-agent's repo guard for every Prime session, whatever its cwd. The rules live in that repo's
 * scripts/repo/agent/guards/ and judge each command by where it runs (cd, git -C, the push remote's URL), so a session
 * started in /Users/sieunpark that touches the checkout gets the rules a session started there gets.
 * On 2026-10-14 at 14:40Z a job started in /Users/sieunpark pushed sieun/dev from that checkout, and no guard loaded for it.
 * GLOBAL_RULES_AUTO_SNS_AGENT moves the checkout, so a test can point it at a fixture.
 */
export const CHECKOUT = process.env.GLOBAL_RULES_AUTO_SNS_AGENT || join(homedir(), "Documents/Github/auto-sns-agent");
const GUARDS = join(CHECKOUT, "scripts/repo/agent/guards");

type Verdict = { block: true; reason: string } | undefined;
type Ctx = { cwd?: string; sessionManager?: { getSessionId(): string | null | undefined } };
interface Adapter {
	registerRepoGuard(pi: { on(name: string, handler: (event: unknown, ctx: unknown) => unknown): void }): void;
	onToolCall(event: Pick<ToolCallEvent, "toolName" | "input">, ctx: Ctx): Verdict;
}

/*
 * A worker process keeps every imported .mjs for its life, so a guard imported once stayed stale: c84c6c646e reached
 * us-metal02 at 08:46:35Z on 10-18, and sessions in the 26 workers started before it were refused named-file checks it
 * allows until about 11:00Z. Each call stats the guard files, and a change imports a copy at
 * <checkout>/.cache/repo-guard/<content hash>/guards/, a new URL, so prime.mjs and every module it imports load fresh.
 * The copy sits four levels below the checkout like the original, so the guards' REPO_ROOT still names the checkout.
 */
const guardFiles = (): string[] => readdirSync(GUARDS).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs")).sort();
const stampOf = (files: string[]): string => files.map((name) => {
	const s = statSync(join(GUARDS, name));
	return `${name}:${s.mtimeMs}:${s.size}`;
}).join("|");

function snapshot(files: string[]): string {
	const hash = createHash("sha256");
	for (const name of files) hash.update(`${name}\0`).update(readFileSync(join(GUARDS, name))).update("\0");
	const dir = join(CHECKOUT, ".cache/repo-guard", hash.digest("hex").slice(0, 16));
	if (!existsSync(join(dir, "guards/prime.mjs"))) {
		const tmp = `${dir}.${process.pid}`;
		mkdirSync(join(tmp, "guards"), { recursive: true });
		for (const name of files) copyFileSync(join(GUARDS, name), join(tmp, "guards", name));
		try {
			renameSync(tmp, dir);
		} catch {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
	return join(dir, "guards/prime.mjs");
}

let loaded: { stamp: string; adapter: Promise<Adapter> } | null = null;

/** The guard as its files read now. A version that fails to read or import keeps the last one that loaded. */
async function loadAdapter(): Promise<Adapter> {
	const previous = loaded;
	try {
		const files = guardFiles();
		const stamp = stampOf(files);
		if (previous?.stamp === stamp) return await previous.adapter;
		const adapter = import(pathToFileURL(snapshot(files)).href) as Promise<Adapter>;
		loaded = { stamp, adapter };
		return await adapter;
	} catch (error) {
		if (!previous) throw error;
		loaded = { stamp: loaded?.stamp ?? previous.stamp, adapter: previous.adapter };
		return previous.adapter;
	}
}

type Handler = (event: unknown, ctx: unknown) => unknown;
const versions = new WeakMap<Adapter, Map<string, Handler>>();

/** The handlers the guard registers now, by event name. */
async function handlers(): Promise<Map<string, Handler>> {
	const adapter = await loadAdapter();
	let byName = versions.get(adapter);
	if (!byName) {
		const recorded = new Map<string, Handler>();
		adapter.registerRepoGuard({ on: (name, handler) => recorded.set(name, handler) });
		versions.set(adapter, (byName = recorded));
	}
	return byName;
}

/** Registers the repo guard, which follows its files at each event. A load error reaches index.ts, which logs it. */
export async function register(pi: Pick<ExtensionAPI, "on">): Promise<void> {
	if (!existsSync(CHECKOUT)) return;
	const target = pi as unknown as { on(name: string, handler: Handler): void };
	for (const name of (await handlers()).keys()) target.on(name, async (event, ctx) => (await handlers()).get(name)?.(event, ctx));
}

/** A root session's kernel has RLM_SESSION_DIR=<artifacts>/<session id>; a subagent's ends in sub-<n> and is never the release owner. */
export function sessionIdOf(sessionDir: string | undefined): string | null {
	const name = sessionDir ? basename(sessionDir) : "";
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name) ? name : null;
}

/**
 * The kernel half: send-check.ts runs this for a git write or a local check a Python kernel starts, with the kernel's
 * real cwd and the command's expanded text, which the tool_call text cannot show after an os.chdir or an f-string.
 */
export async function judgeKernelShell(text: string, cwd: string, sessionDir: string | undefined): Promise<Verdict> {
	if (!existsSync(CHECKOUT)) return undefined;
	const adapter = await loadAdapter();
	const id = sessionIdOf(sessionDir);
	return adapter.onToolCall({ toolName: "bash", input: { command: text } }, { cwd, sessionManager: { getSessionId: () => id } });
}
