import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, isAbsolute } from "node:path";
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
const ADAPTER = join(CHECKOUT, "scripts/repo/agent/guards/prime.mjs");
const RISKY = /\b(git|vercel|railway|convex|pnpm|npx|uv|pytest|ruff|tsc|vitest|turbo|grep)\b/;

type Verdict = { block: true; reason: string } | undefined;
type Ctx = { cwd?: string; sessionManager?: { getSessionId(): string | null | undefined } };
interface Adapter {
	registerRepoGuard(pi: Pick<ExtensionAPI, "on">): void;
	onToolCall(event: Pick<ToolCallEvent, "toolName" | "input">, ctx: Ctx): Verdict;
}

const loadAdapter = (): Promise<Adapter> => import(pathToFileURL(ADAPTER).href);

function insideCheckout(dir: string | undefined): boolean {
	if (!dir) return false;
	try {
		const rel = relative(realpathSync(CHECKOUT), realpathSync(dir));
		return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
	} catch {
		return false;
	}
}

/**
 * Registers the repo guard. When the checkout is there but its rules fail to load, a call that looks like a git write,
 * a deploy or a local check is refused in a session started in the checkout, or when its text names auto-sns-agent,
 * and the error is rethrown so index.ts logs it.
 */
export async function register(pi: Pick<ExtensionAPI, "on">): Promise<void> {
	if (!existsSync(CHECKOUT)) return;
	try {
		(await loadAdapter()).registerRepoGuard(pi);
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		pi.on("tool_call", (event: ToolCallEvent, ctx: Ctx) => {
			const input = event.input as Record<string, unknown>;
			const text = event.toolName === "bash" ? input.command : event.toolName === "ipython" ? input.code : undefined;
			if (typeof text !== "string" || !RISKY.test(text)) return undefined;
			if (!insideCheckout(ctx?.cwd) && !text.includes("auto-sns-agent")) return undefined;
			return { block: true, reason: `repo guard (guard-error): ${ADAPTER} failed to load (${why}).` };
		});
		throw error;
	}
}

/** A root session's kernel has RLM_SESSION_DIR=<artifacts>/<session id>; a subagent's ends in sub-<n> and is never the release owner. */
export function sessionIdOf(sessionDir: string | undefined): string | null {
	const name = sessionDir ? basename(sessionDir) : "";
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name) ? name : null;
}

/**
 * The kernel half: send-check.ts runs this for a git write a Python kernel starts, with the kernel's real cwd,
 * which the tool_call text cannot show after an os.chdir.
 */
export async function judgeKernelShell(text: string, cwd: string, sessionDir: string | undefined): Promise<Verdict> {
	if (!existsSync(CHECKOUT)) return undefined;
	const adapter = await loadAdapter();
	const id = sessionIdOf(sessionDir);
	return adapter.onToolCall({ toolName: "bash", input: { command: text } }, { cwd, sessionManager: { getSessionId: () => id } });
}
