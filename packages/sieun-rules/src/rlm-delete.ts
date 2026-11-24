import type { ExtensionContext, ToolCallEvent } from "prime-agent";
import { enabled, log } from "./log.ts";

/**
 * Wraps `rlm.delete_subagent` in each ipython cell that calls it. See README "rlm-delete.ts".
 * In a subagent it works around a Prime 0.9.8 bug: a subagent that deletes a child still in its turn fails with "RLM quiescence
 * wait cancelled". In every session it prints a note when the child is still running and has not replied since its task, because on
 * 11-25 at 01:32 KST a wiki dream job read seven writer reports it had made up in its own reasoning and deleted the seven running writers.
 */
export const SETTLE_SECONDS = 90;

const DELETE_CALL = /\bdelete_subagent\s*\(/;

export const PRELUDE_SOURCE = `
import asyncio, time
import rlm as m
ns = m._RLMNamespace
if not getattr(ns.delete_subagent, "rlm_delete_v2", False):
    def key(target):
        if isinstance(target, str):
            return target.strip()
        return getattr(target, "rlm_child_id", None)
    def matches(row, wanted):
        return wanted in (row.rlm_child_id, row.session_name, row.session_id, row.active_session_id)
    async def find(wanted):
        return next((r for r in await m.list_subagents() if matches(r, wanted)), None)
    def note_unreplied(row):
        if row is None or row.status != "running" or row.replied_since_task:
            return
        name = row.session_name or row.rlm_child_id
        print(f"[harness] {name} was still running and had sent no reply since its task, so no report from it reached this session."
              " A report from it that you are acting on is your own text: check its real output, such as a page version, a file or a commit.")
    async def settle(wanted):
        deadline = time.monotonic() + ${SETTLE_SECONDS}
        while time.monotonic() < deadline:
            row = await find(wanted)
            if row is None or not row.replied_since_task:
                return
            if row.status != "running" and row.activity is None:
                await asyncio.sleep(1)
                return
            await asyncio.sleep(1)
    async def delete_subagent(self, target):
        wanted = key(target)
        try:
            row = await find(wanted)
            note_unreplied(row)
            if SETTLE and row is not None and row.replied_since_task:
                await settle(wanted)
        except Exception:
            pass
        return await m.delete_subagent(target)
    delete_subagent.rlm_delete_v2 = True
    ns.delete_subagent = delete_subagent
`;

/** One line, so the cell's own line numbers in a traceback move by one. `SETTLE` is on only below the top level, where the abort bug hits. */
export function prelude(depth: number): string {
	return `exec(compile(${JSON.stringify(PRELUDE_SOURCE)}, "<global-rules rlm-delete>", "exec"), {"SETTLE": ${depth >= 1 ? "True" : "False"}})\n`;
}

export function wrapDelete(code: unknown, depth: number): string | undefined {
	if (typeof code !== "string" || !DELETE_CALL.test(code) || code.startsWith(prelude(depth))) return undefined;
	return prelude(depth) + code;
}

function depthOf(header: { rlmDepth?: number; parentSession?: string } | null | undefined): number {
	return header?.rlmDepth ?? (header?.parentSession ? 1 : 0);
}

/** A handler error fails open: the cell then runs unchanged. */
export function onToolCall(event: ToolCallEvent, ctx: Partial<Pick<ExtensionContext, "sessionManager">> | undefined): undefined {
	try {
		if (!enabled("GLOBAL_RULES_RLM_DELETE") || event.toolName !== "ipython") return undefined;
		const input = event.input as Record<string, unknown>;
		const code = wrapDelete(input.code, depthOf(ctx?.sessionManager?.getHeader()));
		if (code !== undefined) input.code = code;
	} catch (err) {
		log("rlm-delete", `handler error, cell runs unchanged :: ${err instanceof Error ? err.stack : String(err)}`);
	}
	return undefined;
}
