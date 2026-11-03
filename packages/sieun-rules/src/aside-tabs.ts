import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "prime-agent";
import { enabled, log, logPath } from "./log.ts";
import { agentDir, contextSessionDir, sessionDirOf } from "./paths.ts";

/*
 * Closes a session's own tabs when its turn ends. aside_browser's sweep closes a tab only after the kernel that opened it exits, and a
 * finished job's kernel lives on while its session stays loaded, so on 10-29 15 of the 17 tabs in the owner's Aside (10.6 GB) were tabs of
 * jobs that had ended their turn, and on 11-02 walk orgs read 41 GB of staging Convex in reruns of box tabs left open after walks.
 * A job closes its Aside and box tabs. A top-level chat keeps its Aside tabs, because it may open a page for the owner to look at, and stops
 * its box Chrome, which renders on a hidden display nobody looks at.
 * The close runs aside_browser in a detached kernel-venv python, so agent_end does not wait for the Mac. That python stops the box runner
 * the kernel started through the runner's pid record (stop_box()).
 */
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
/** The aside_browser of this same release, because the kernel venv's editable install can point at an older one. */
const SKILL_SRC = resolve(HERE, "../../../skills/aside-browser/src");
const CLOSE = {
	all: "import asyncio, aside_browser; print('[aside-tabs] closed', asyncio.run(aside_browser.close_own_tabs()), flush=True)",
	box: "import asyncio, aside_browser; print('[aside-tabs] stopped', asyncio.run(aside_browser.stop_box()), flush=True)",
} as const;
type Scope = keyof typeof CLOSE;

type Ctx = Partial<Pick<ExtensionContext, "sessionManager">> | undefined;

/** The kernel folder of a subagent session (depth 1 or more, or a sub-<n> folder), else null for a top-level chat. */
export function jobSessionDir(ctx: Ctx): string | null {
	const manager = ctx?.sessionManager;
	const dir = sessionDirOf(manager?.getSessionFile?.(), manager?.getSessionId?.());
	if (!dir) return null;
	const header = manager?.getHeader?.() as { rlmDepth?: number; parentSession?: string } | null | undefined;
	const depth = header?.rlmDepth ?? (header?.parentSession ? 1 : 0);
	return depth >= 1 || basename(dir).startsWith("sub-") ? dir : null;
}

/** aside_browser's _registry_path(): one file per owning session, named by the sha1 of its RLM_SESSION_DIR. */
export function registryPath(sessionDir: string, env: NodeJS.ProcessEnv = process.env): string {
	const state = env.ASIDE_BROWSER_STATE || join(homedir(), ".local", "state", "aside-browser", "owners");
	return join(state, `${createHash("sha1").update(sessionDir).digest("hex").slice(0, 16)}.json`);
}

/** aside_browser's _box_record_path(): the pid record of the session's box runner, beside its tab record. */
export function boxRecordPath(sessionDir: string, env: NodeJS.ProcessEnv = process.env): string {
	return registryPath(sessionDir, env).replace(/\.json$/, ".box");
}

function hasRecord(sessionDir: string, scope: Scope, env: NodeJS.ProcessEnv): boolean {
	if (existsSync(boxRecordPath(sessionDir, env))) return true;
	return scope === "all" && (existsSync(registryPath(sessionDir, env)) || existsSync(join(sessionDir, "aside-browser-tabs.json")));
}

/** Starts the detached close when the session has a record for that scope: "all" closes Aside and box tabs, "box" stops only the box
 * Chrome. Returns whether it started one. */
export function closeTabs(sessionDir: string, scope: Scope, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!hasRecord(sessionDir, scope, env)) return false;
	const python = env.GLOBAL_RULES_ASIDE_PYTHON || join(agentDir(env), "kernel-venv", "bin", "python");
	const out = openSync(logPath(), "a");
	try {
		const child = spawn(python, ["-B", "-c", CLOSE[scope]], {
			detached: true,
			stdio: ["ignore", out, out],
			env: { ...env, RLM_SESSION_DIR: sessionDir, PYTHONPATH: existsSync(SKILL_SRC) ? SKILL_SRC : "" },
		});
		child.on("error", (err) => log("aside-tabs", `close of ${sessionDir} did not start :: ${err.message}`));
		child.unref();
	} finally {
		closeSync(out);
	}
	return true;
}

/** A handler error fails open: the tabs then stay until the kernel exits. */
export function onAgentEnd(ctx: Ctx): void {
	try {
		if (!enabled("GLOBAL_RULES_ASIDE_TABS")) return;
		const job = jobSessionDir(ctx);
		const dir = job ?? contextSessionDir(ctx);
		if (dir && closeTabs(dir, job ? "all" : "box")) log("aside-tabs", `closing the ${job ? "tabs" : "box Chrome"} of ${dir}`);
	} catch (err) {
		log("aside-tabs", `handler error, tabs stay open :: ${err instanceof Error ? err.stack : String(err)}`);
	}
}
