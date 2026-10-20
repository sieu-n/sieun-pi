import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "prime-agent";
import { sessionDirOf } from "./kernel-cwd.ts";
import { enabled, log } from "./log.ts";

/*
 * The tool_call half of the transcript guard: a `read`, `grep` or `bash` tool call that reads another family's session transcript is
 * refused with kernel-read.py's own rules (`--judge`), so the tools and the kernel give one answer. An ipython cell is judged in the kernel
 * at run time, where its paths are known. Only a call whose text names a session folder or the Prime agent dir starts the judge.
 */
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const JUDGE = join(HERE, "kernel-read.py");
const HINT = /session|\.prime/;

type Ctx = Partial<Pick<ExtensionContext, "cwd" | "sessionManager">> | undefined;

export function judgeTool(tool: string, input: Record<string, unknown>, cwd: string, session: string): string | undefined {
	const text = tool === "bash" ? input.command : (input.path ?? input.file_path);
	if (typeof text !== "string" || !(HINT.test(text) || HINT.test(cwd))) return undefined;
	const request = tool === "bash" ? { tool, text, cwd, session } : { tool, path: text, cwd, session };
	const run = spawnSync("python3", ["-B", JUDGE, "--judge"], { input: JSON.stringify(request), encoding: "utf8", env: { ...process.env, PYTHONPATH: "" } });
	if (run.status !== 0) {
		log("transcript", `judge failed, failing open :: ${run.stderr.slice(0, 500)}`);
		return undefined;
	}
	const verdict = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as { refuse?: string | null };
	return verdict.refuse ?? undefined;
}

/** A handler error fails open, like the other guards. */
export function onToolCall(event: ToolCallEvent, ctx: Ctx): ToolCallEventResult | undefined {
	try {
		if (!enabled("GLOBAL_RULES_GUARD") || !["read", "grep", "bash"].includes(event.toolName)) return undefined;
		const session = sessionDirOf(ctx?.sessionManager?.getSessionFile?.()) ?? process.env.RLM_SESSION_DIR ?? "";
		if (!session) return undefined;
		const reason = judgeTool(event.toolName, event.input as Record<string, unknown>, ctx?.cwd ?? process.cwd(), session);
		if (!reason) return undefined;
		log("transcript", `block tool=${event.toolName} session=${session}`);
		return { block: true, reason };
	} catch (err) {
		log("transcript", `handler error, failing open :: ${err instanceof Error ? err.stack : String(err)}`);
		return undefined;
	}
}
