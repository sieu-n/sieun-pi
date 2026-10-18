import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

type Verdict = { block: true; reason: string } | undefined;
type Ctx = { cwd?: string; sessionManager?: { getSessionId(): string | null | undefined } };
interface Adapter {
	registerRepoGuard(pi: { on(name: string, handler: (event: unknown, ctx: unknown) => unknown): void }): void;
	onToolCall(event: Pick<ToolCallEvent, "toolName" | "input">, ctx: Ctx): Verdict;
}

/*
 * A worker process keeps every imported .mjs for its life, so a guard imported once stayed stale: c84c6c646e reached
 * us-metal02 at 08:46:35Z on 10-18, and sessions in the 26 workers started before it were refused named-file checks it
 * allows until about 11:00Z. Each call reads HEAD's commit id from .git (two small reads), and a new commit whose guard
 * tree changed imports a copy of that tree's blobs at <checkout>/.cache/repo-guard/<tree id>/guards/, a new URL, so
 * prime.mjs and every module it imports load fresh. Only landed guard code is live: on 10-18 at 11:48Z a session's unsaved
 * edit to the shared tree's guards/git.mjs dropped the hooks-off push check for every session. The copy sits four levels
 * below the checkout like the original, so the guards' REPO_ROOT still names the checkout.
 */
const GUARDS_PATH = "scripts/repo/agent/guards";
const git = (...args: string[]): Buffer =>
	execFileSync("/usr/bin/git", ["-C", CHECKOUT, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });

/** HEAD's commit id, from .git/HEAD and its loose ref, else from git. */
function headId(): string {
	try {
		const head = readFileSync(join(CHECKOUT, ".git/HEAD"), "utf8").trim();
		return head.startsWith("ref: ") ? readFileSync(join(CHECKOUT, ".git", head.slice(5)), "utf8").trim() : head;
	} catch {
		return git("rev-parse", "--verify", "-q", "HEAD").toString().trim();
	}
}

/** The guard files HEAD holds, copied once per guard tree id; returns the copy's prime.mjs. */
function snapshot(head: string): string {
	const tree = git("rev-parse", `${head}:${GUARDS_PATH}`).toString().trim();
	const dir = join(CHECKOUT, ".cache/repo-guard", tree.slice(0, 16));
	if (!existsSync(join(dir, "guards/prime.mjs"))) {
		const tmp = `${dir}.${process.pid}`;
		mkdirSync(join(tmp, "guards"), { recursive: true });
		for (const entry of git("ls-tree", "-z", tree).toString().split("\0")) {
			const [meta, name] = entry.split("\t");
			const [, type, blob] = meta?.split(" ") ?? [];
			if (type !== "blob" || !name?.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
			writeFileSync(join(tmp, "guards", name), git("cat-file", "blob", blob!));
		}
		try {
			renameSync(tmp, dir);
		} catch {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
	return join(dir, "guards/prime.mjs");
}

let loaded: { stamp: string; adapter: Promise<Adapter> } | null = null;

/** The guard as HEAD holds it now. A version that fails to read or import keeps the last one that loaded. */
async function loadAdapter(): Promise<Adapter> {
	const previous = loaded;
	try {
		const stamp = headId();
		if (previous?.stamp === stamp) return await previous.adapter;
		const adapter = import(pathToFileURL(snapshot(stamp)).href) as Promise<Adapter>;
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

/** Registers the repo guard, which follows HEAD's guard files at each event. A load error reaches index.ts, which logs it. */
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
